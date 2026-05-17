"""Faster-Whisper CLI ラッパー（AIP-24）。

音声ファイルを引数で受け取り、文字起こし結果を stdout に JSON で出力する。
進捗ログ等は stderr に出す。Node.js から `child_process.spawn` で叩く想定。

使い方:
    python scripts/transcribe.py <audio_path> [--model NAME] [--device DEV]
                                              [--language LANG] [--no-vad]
                                              [--compute-type TYPE]

stdout (JSON):
    {
      "audio_path": "...",
      "model": "large-v3-turbo",
      "device": "cuda",
      "language": "ja",
      "language_probability": 0.99,
      "duration_sec": 123.4,
      "elapsed_sec": 3.5,
      "realtime_factor": 35.2,
      "segments": [{"start": 0.0, "end": 2.5, "text": "..."}, ...]
    }

stderr: 進捗ログ
exit code: 成功 0 / 失敗 1
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path


def setup_cuda_paths() -> None:
    """Windows で venv 内の NVIDIA DLL がデフォルトで認識されない問題への対処。"""
    if sys.platform != "win32":
        return
    venv_path = Path(sys.executable).parent.parent
    cuda_paths = [
        venv_path / "Lib" / "site-packages" / "nvidia" / "cublas" / "bin",
        venv_path / "Lib" / "site-packages" / "nvidia" / "cudnn" / "bin",
        venv_path / "Lib" / "site-packages" / "nvidia" / "cuda_nvrtc" / "bin",
    ]
    for path in cuda_paths:
        if path.exists():
            os.add_dll_directory(str(path))
            os.environ["PATH"] = str(path) + os.pathsep + os.environ["PATH"]


def log(msg: str) -> None:
    """stderr へ進捗ログを出す（stdout は JSON 専用なので汚さない）。"""
    print(msg, file=sys.stderr, flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Faster-Whisper で音声ファイルを文字起こしし JSON を stdout に出力する。",
    )
    parser.add_argument("audio_path", help="文字起こし対象の音声ファイルパス")
    parser.add_argument(
        "--model",
        default="large-v3-turbo",
        help="Whisper モデル名（既定: large-v3-turbo）",
    )
    parser.add_argument(
        "--device",
        default="cuda",
        choices=["cuda", "cpu", "auto"],
        help="推論デバイス（既定: cuda）",
    )
    parser.add_argument(
        "--compute-type",
        default="float16",
        help="推論精度（cuda+float16, cpu+int8 推奨。既定: float16）",
    )
    parser.add_argument(
        "--language",
        default="ja",
        help="言語コード（既定: ja）。auto 検出させたい場合は `auto`",
    )
    parser.add_argument(
        "--beam-size",
        type=int,
        default=5,
        help="Beam search サイズ（既定: 5）",
    )
    parser.add_argument(
        "--no-vad",
        action="store_true",
        help="VAD フィルタを無効化（既定は有効）",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    audio_path = Path(args.audio_path)

    if not audio_path.exists():
        log(f"ERROR: audio file not found: {audio_path}")
        return 1
    if not audio_path.is_file():
        log(f"ERROR: not a regular file: {audio_path}")
        return 1

    setup_cuda_paths()

    # ここで初めて faster_whisper を import（DLL パス設定の後でないと失敗する）
    log(f"loading model: {args.model} (device={args.device}, compute={args.compute_type})")
    from faster_whisper import WhisperModel

    model = WhisperModel(
        args.model,
        device=args.device,
        compute_type=args.compute_type,
    )
    log("model loaded")

    log(f"transcribing: {audio_path.name}")
    start = time.perf_counter()

    language: str | None = None if args.language == "auto" else args.language
    segments_iter, info = model.transcribe(
        str(audio_path),
        language=language,
        beam_size=args.beam_size,
        vad_filter=not args.no_vad,
        condition_on_previous_text=False,  # 幻覚抑制
    )

    duration_sec = float(info.duration)

    # セグメントを iterate しつつフィルタ
    segments_out: list[dict[str, object]] = []
    for seg in segments_iter:
        # 音声長を超えるセグメントは破棄（幻覚対策）
        if seg.start > duration_sec + 1.0:
            log(f"drop hallucinated segment: start={seg.start:.2f} > duration={duration_sec:.2f}")
            continue
        segments_out.append(
            {
                "start": round(float(seg.start), 3),
                "end": round(float(seg.end), 3),
                "text": seg.text.strip(),
            }
        )

    elapsed = time.perf_counter() - start
    rt_factor = duration_sec / elapsed if elapsed > 0 else 0.0

    log(
        f"done: {len(segments_out)} segments, duration={duration_sec:.1f}s, "
        f"elapsed={elapsed:.1f}s, rt_factor={rt_factor:.2f}x"
    )

    result = {
        "audio_path": str(audio_path),
        "model": args.model,
        "device": args.device,
        "language": info.language,
        "language_probability": round(float(info.language_probability), 4),
        "duration_sec": round(duration_sec, 3),
        "elapsed_sec": round(elapsed, 3),
        "realtime_factor": round(rt_factor, 2),
        "segments": segments_out,
    }
    # stdout は ensure_ascii=False で日本語をそのまま出す
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    try:
        code = main()
    except KeyboardInterrupt:
        log("interrupted")
        code = 130
    except Exception as e:  # noqa: BLE001
        log(f"FATAL: {type(e).__name__}: {e}")
        code = 1
    # CTranslate2 / faster-whisper のデストラクタが CUDA 解放時に Windows で
    # 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN, exit code 3221226505) で死ぬのを
    # 避けるため、通常の sys.exit ではなく os._exit で即終了する（デストラクタをスキップ）。
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)
