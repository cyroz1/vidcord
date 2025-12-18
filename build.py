import os
import sys
import subprocess
import platform
import shutil
import re

def get_version():
    with open("vidcord.py", "r") as f:
        content = f.read()
        match = re.search(r'CURRENT_VERSION = "(.*)"', content)
        if match:
            return match.group(1).lstrip('v')
    return "0.0.0"

def run_command(cmd, cwd=None):
    print(f"Running: {' '.join(cmd) if isinstance(cmd, list) else cmd}")
    result = subprocess.run(cmd, cwd=cwd, shell=True if isinstance(cmd, str) and platform.system() == "Windows" else False)
    if result.returncode != 0:
        print(f"Error: Command failed with return code {result.returncode}")
        sys.exit(result.returncode)

def build_windows():
    print("Building for Windows...")
    version = get_version()
    
    # 1. Run PyInstaller
    run_command(["pyinstaller", "--noconfirm", "platforms/windows/vidcord.spec"])
    
    # 2. Run Inno Setup
    # Assumes ISCC is in PATH or common location
    iscc = shutil.which("ISCC.exe")
    if not iscc:
        # Try common location
        potential_path = r"C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
        if os.path.exists(potential_path):
            iscc = potential_path
            
    if iscc:
        run_command([iscc, f"/DMyAppVersion={version}", "platforms/windows/script.iss"])
    else:
        print("Warning: ISCC.exe not found. skipping installer creation.")

def build_linux():
    print("Building for Linux...")
    # 1. Run PyInstaller via build_linux.sh or directly
    run_command(["bash", "platforms/linux/build_linux.sh"])
    
    # 2. Run AppImage build
    run_command(["bash", "platforms/linux/build_appimage.sh"])

def build_macos():
    print("Building for macOS...")
    # 1. Run PyInstaller
    run_command(["pyinstaller", "--noconfirm", "platforms/macos/vidcord_mac.spec"])
    
    # 2. Run pkg build
    run_command(["bash", "platforms/macos/build_pkg.sh"])

def main():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    
    system = platform.system()
    if system == "Windows":
        build_windows()
    elif system == "Linux":
        build_linux()
    elif system == "Darwin":
        build_macos()
    else:
        print(f"Unsupported system: {system}")
        sys.exit(1)

if __name__ == "__main__":
    main()
