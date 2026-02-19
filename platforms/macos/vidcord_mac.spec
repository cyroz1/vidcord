# -*- mode: python ; coding: utf-8 -*-
# NOTE: block_cipher was removed (deprecated in PyInstaller 6, always None)

from PyInstaller.utils.hooks import collect_all
import platform

datas = [('ffmpeg', 'bin'), ('ffprobe', 'bin'), ('icon.icns', '.'), ('../../icon.ico', '.')]
binaries = []
hiddenimports = ['ffmpeg']

# Collect all resources for qfluentwidgets
tmp_ret = collect_all('qfluentwidgets')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]

# Detect the host arch at build time so the spec works on both arm64 and x86_64
host_arch = platform.machine()  # 'arm64' or 'x86_64'

a = Analysis(
    ['../../vidcord.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='vidcord',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,   # True causes crashes on Ventura+ with some frameworks
    target_arch=host_arch,
    codesign_identity=None,
    entitlements_file=None,
    icon='icon.icns',
)
coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='vidcord',
)
app = BUNDLE(
    coll,
    name='vidcord.app',
    icon='icon.icns',
    bundle_identifier='com.cyroz1.vidcord',
    bundle_architecture=host_arch,
    info_plist={
        'CFBundleDocumentTypes': [
            {
                'CFBundleTypeName': 'Video',
                'CFBundleTypeRole': 'Viewer',
                'LSHandlerRank': 'Default',
                'CFBundleTypeExtensions': ['mp4', 'avi', 'mov', 'mkv', 'flv', 'wmv', 'webm'],
                'CFBundleTypeMIMETypes': ['video/mp4', 'video/x-msvideo', 'video/quicktime', 'video/x-matroska', 'video/x-flv', 'video/x-ms-wmv', 'video/webm'],
                'LSItemContentTypes': [
                    'public.mpeg-4',
                    'public.avi',
                    'com.apple.quicktime-movie',
                    'org.matroska.mkv',
                    'public.mpeg',
                    'public.webm-video',
                    'com.microsoft.windows-media-wmv'
                ],
            }
        ]
    }
)
