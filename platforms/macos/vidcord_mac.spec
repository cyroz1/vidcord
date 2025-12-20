# -*- mode: python ; coding: utf-8 -*-

block_cipher = None

from PyInstaller.utils.hooks import collect_all

datas = [('ffmpeg', 'bin'), ('ffprobe', 'bin'), ('icon.icns', '.'), ('../../icon.ico', '.')]
binaries = []
hiddenimports = ['ffmpeg']

# Collect all resources for qfluentwidgets
tmp_ret = collect_all('qfluentwidgets')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]

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
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

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
    argv_emulation=True,
    target_arch='arm64',
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
    bundle_architecture='arm64',
    info_plist={
        'CFBundleDocumentTypes': [
            {
                'CFBundleTypeName': 'Video',
                'CFBundleTypeRole': 'Viewer',
                'LSHandlerRank': 'Default',
                'CFBundleTypeExtensions': ['mp4', 'avi', 'mov', 'mkv', 'flv', 'wmv', 'webm'],
                'CFBundleTypeMIMETypes': ['video/mp4', 'video/x-msvideo', 'video/quicktime', 'video/x-matroska', 'video/x-flv', 'video/x-ms-wmv', 'video/webm'],
            }
        ],
        'NSServices': [
            {
                'NSMenuItem': {
                    'default': 'Compress with Vidcord'
                },
                'NSMessage': 'dropService',
                'NSPortName': 'vidcord',
                'NSSendTypes': ['NSFilenamesPboardType'],
                'NSRequiredContext': {
                    'NSTextContent': 'FilePath'
                }
            }
        ]
    }
)

