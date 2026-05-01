import os
import sys
from pathlib import Path

print("=" * 60)
print("Python実行環境の確認")
print("=" * 60)
print(f"Python実行ファイル: {sys.executable}")
print(f"Pythonバージョン: {sys.version}")
print()

venv_path = Path(sys.executable).parent.parent
print(f"venvルート(推定): {venv_path}")
print()

print("=" * 60)
print("CUDA DLL の存在確認")
print("=" * 60)

cuda_paths = [
    venv_path / "Lib" / "site-packages" / "nvidia" / "cublas" / "bin",
    venv_path / "Lib" / "site-packages" / "nvidia" / "cudnn" / "bin",
    venv_path / "Lib" / "site-packages" / "nvidia" / "cuda_nvrtc" / "bin",
]

for path in cuda_paths:
    print(f"\nパス: {path}")
    print(f"  存在する: {path.exists()}")
    if path.exists():
        files = list(path.glob("*.dll"))
        print(f"  DLLファイル数: {len(files)}")
        for f in files[:5]:
            print(f"    - {f.name}")
        try:
            os.add_dll_directory(str(path))
            print(f"  ✅ DLL検索パスに追加成功")
        except Exception as e:
            print(f"  ❌ 追加失敗: {e}")

print("\n" + "=" * 60)
print("ctranslate2 の動作確認")
print("=" * 60)
try:
    import ctranslate2
    print(f"ctranslate2 バージョン: {ctranslate2.__version__}")
    print(f"CUDA デバイス数: {ctranslate2.get_cuda_device_count()}")
except Exception as e:
    print(f"❌ エラー: {type(e).__name__}: {e}")