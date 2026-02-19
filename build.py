import os
import sys
import subprocess
import platform
import shutil
import re
import argparse

def get_version():
    with open("vidcord.py", "r") as f:
        content = f.read()
        match = re.search(r'CURRENT_VERSION = "(.*)"', content)
        if match:
            version = match.group(1).lstrip('v')
            # Sanitize: keep only alphanumeric, dots, and hyphens
            return re.sub(r'[^a-zA-Z0-9.-]', '', version)
    return "0.0.0"

def run_command(cmd, cwd=None):
    print(f"Running: {' '.join(cmd) if isinstance(cmd, list) else cmd}")
    result = subprocess.run(cmd, cwd=cwd, shell=True if isinstance(cmd, str) and platform.system() == "Windows" else False)
    if result.returncode != 0:
        print(f"Error: Command failed with return code {result.returncode}")
        sys.exit(result.returncode)

def build_windows(arch="x86_64"):
    print(f"Building for Windows ({arch})...")
    version = get_version()
    
    # 1. Run PyInstaller
    pyinstaller = shutil.which("pyinstaller.exe")
    if not pyinstaller:
        # Try local venv
        potential_pyi = os.path.join(".venv", "Scripts", "pyinstaller.exe")
        if os.path.exists(potential_pyi):
            pyinstaller = potential_pyi
            
    if not pyinstaller:
        print("Error: pyinstaller.exe not found. Please install it in your venv.")
        sys.exit(1)

    run_command([pyinstaller, "--noconfirm", "platforms/windows/vidcord.spec"])
    
    # 2. Run Inno Setup
    # Assumes ISCC is in PATH or common location
    iscc = shutil.which("ISCC.exe")
    if not iscc:
        # Try common locations
        potential_paths = [
            r"C:\Program Files\Inno Setup 6\ISCC.exe",
            r"C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
        ]
        for path in potential_paths:
            if os.path.exists(path):
                iscc = path
                break
            
    if iscc:
        output_filename = f"vidcord_v{version}_{arch}"
        run_command([iscc, f"/DMyAppVersion={version}", f"/DMyArch={arch}", f"/DMyOutputBaseFilename={output_filename}", "platforms/windows/script.iss"])
    else:
        print("Warning: ISCC.exe not found. skipping installer creation.")

def build_linux():
    print("Building for Linux...")
    project_root = os.path.dirname(os.path.abspath(__file__))
    # 1. Run PyInstaller via build_linux.sh
    run_command(["bash", "platforms/linux/build_linux.sh"], cwd=project_root)
    # 2. Run AppImage build (must run from project root so relative paths resolve)
    run_command(["bash", "platforms/linux/build_appimage.sh"], cwd=project_root)

def build_macos():
    print("Building for macOS...")
    project_root = os.path.dirname(os.path.abspath(__file__))

    # Remove old .app bundle before PyInstaller runs to avoid PermissionError
    # when macOS code-signs the bundle and makes files read-only.
    old_app = os.path.join(project_root, "dist", "vidcord.app")
    if os.path.isdir(old_app):
        print(f"Removing old bundle: {old_app}")
        subprocess.run(["sudo", "rm", "-rf", old_app], check=True)

    # 1. Run PyInstaller — prefer the venv binary so the correct Python is used
    pyinstaller = os.path.join(project_root, ".venv", "bin", "pyinstaller")
    if not os.path.exists(pyinstaller):
        pyinstaller = shutil.which("pyinstaller") or "pyinstaller"
    run_command([pyinstaller, "--noconfirm", "platforms/macos/vidcord_mac.spec"])

    # 2. Build the .pkg installer
    run_command(["bash", "platforms/macos/build_pkg.sh"])

def main():
    parser = argparse.ArgumentParser(description="Build vidcord")
    parser.add_argument("--arch", default="x86_64", help="Target architecture (default: x86_64)")
    args = parser.parse_args()
    
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    
    system = platform.system()
    if system == "Windows":
        build_windows(args.arch)
    elif system == "Linux":
        build_linux()
    elif system == "Darwin":
        build_macos()
    else:
        print(f"Unsupported system: {system}")
        sys.exit(1)

if __name__ == "__main__":
    main()
