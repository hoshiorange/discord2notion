import os
import sys
import time
from pathlib import Path

# CUDA DLL のパスを追加(Windows対策)
if sys.platform == "win32":
    venv_path = Path(sys.executable).parent.parent
    cuda_paths = [
        venv_path / "Lib" / "site-packages" / "nvidia" / "cublas" / "bin",
        venv_path / "Lib" / "site-packages" / "nvidia" / "cudnn" / "bin",
        venv_path / "Lib" / "site-packages" / "nvidia" / "cuda_nvrtc" / "bin",
    ]
    for path in cuda_paths:
        if path.exists():
            os.add_dll_directory(str(path))
            # PATH環境変数にも追加(子スレッド継承のため)
            os.environ["PATH"] = str(path) + os.pathsep + os.environ["PATH"]

from faster_whisper import WhisperModel

# スクリプトの場所を基準に samples/test.wav を探す
SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
AUDIO_FILE = PROJECT_ROOT / "samples" / "test.wav"

# 音声ファイルの存在確認
if not AUDIO_FILE.exists():
    print(f"❌ 音声ファイルが見つかりません: {AUDIO_FILE}")
    print(f"   samples/ フォルダに test.wav を置いてください")
    sys.exit(1)

# モデル読み込み(初回はダウンロードに数分かかる、約1.5GB)
print("📦 モデルを読み込み中...")
model = WhisperModel(
    "large-v3-turbo",
    device="cuda",
    compute_type="float16"
)
print("✅ モデル読み込み完了\n")

# 文字起こし実行
print(f"🎤 {AUDIO_FILE.name} を文字起こし中...\n")
start = time.time()

segments, info = model.transcribe(
    str(AUDIO_FILE),
    language="ja",
    beam_size=5,
    vad_filter=True,
)

# 結果表示
print(f"検出言語: {info.language} (信頼度: {info.language_probability:.2f})")
print(f"音声長: {info.duration:.1f}秒\n")

print("=" * 60)
for segment in segments:
    print(f"[{segment.start:6.2f}s -> {segment.end:6.2f}s] {segment.text}")
print("=" * 60)

elapsed = time.time() - start
print(f"\n⏱  処理時間: {elapsed:.1f}秒")
print(f"📊 リアルタイム比: {info.duration/elapsed:.2f}x")