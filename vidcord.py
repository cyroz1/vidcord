import sys
import os
import subprocess
import re
import atexit
# Deferring heavy imports to improve startup time
# import ffmpeg  <-- Moved to VideoProcessor methods
from PyQt6.QtWidgets import (QApplication, QWidget, QVBoxLayout, QHBoxLayout, QFileDialog,
                             QGridLayout, QToolButton, QLineEdit, QDialog, QPlainTextEdit,
                             QDialogButtonBox, QStyle)
from PyQt6.QtCore import Qt, QTimer, QThread, pyqtSignal, QSize, QEvent, QUrl, QRectF, QPointF, QPoint
from PyQt6.QtGui import (QDragEnterEvent, QDropEvent, QIcon, QPixmap, QPalette, QColor,
                         QFont, QFileOpenEvent, QPainterPath, QRegion, QPainter, QImage, QCursor,
                         QDoubleValidator)

MULTIMEDIA_AVAILABLE = True
try:
    from PyQt6.QtMultimedia import QMediaPlayer, QAudioOutput, QVideoSink
except Exception:
    QMediaPlayer = None
    QAudioOutput = None
    QVideoSink = None
    MULTIMEDIA_AVAILABLE = False

try:
    from PyQt6.QtMultimediaWidgets import QVideoWidget
except Exception:
    QVideoWidget = None
import time
import platform
import math
import json
import pathlib
import tempfile
# import requests <-- Moved to checkForUpdates
# from packaging import version <-- Moved to checkForUpdates

# Added HyperlinkButton to imports
from qfluentwidgets import (FluentWindow, NavigationItemPosition, FluentIcon as FIF,
                            PrimaryPushButton, PushButton, ComboBox, CheckBox, Slider,
                            ProgressBar, TitleLabel, SubtitleLabel, BodyLabel, CaptionLabel,
                            InfoBar, InfoBarPosition, Theme, setTheme, CardWidget,
                            SimpleCardWidget, ImageLabel, ScrollArea, HyperlinkButton)

CURRENT_VERSION = "v5.6"

# --- QUALITY PRESETS ---
QUALITY_PRESETS = [
    {"label": "10MB, 480p", "size_mb": 10, "target_h": 480},
    {"label": "25MB, 480p", "size_mb": 25, "target_h": 480},
    {"label": "50MB, 720p", "size_mb": 50, "target_h": 720},
    {"label": "100MB, 1080p", "size_mb": 100, "target_h": 1080},
    {"label": "500MB, native res", "size_mb": 500, "target_h": None},
]

# --- PLATFORM CONSTANTS ---
_CREATION_FLAGS = subprocess.CREATE_NO_WINDOW if platform.system() == 'Windows' else 0

# --- LOGGING SETUP ---
def setup_logging():
    log_path = os.path.join(os.path.expanduser('~'), 'vidcord_crash.log')
    # Open the log file in append mode
    try:
        log_file = open(log_path, 'a')
        # Redirect Python's stdout/stderr
        sys.stdout = log_file
        sys.stderr = log_file
        
        # Redirect C-level stderr (fd 2) to the log file's file descriptor
        # This captures Qt/C++ errors that bypass sys.stderr
        try:
            os.dup2(log_file.fileno(), 2)
            os.dup2(log_file.fileno(), 1)
        except Exception as e:
            print(f"Failed to redirect C-level streams: {e}")
        
        # Ensure log file is closed on exit
        atexit.register(log_file.close)
    except Exception as e:
        print(f"Failed to setup logging: {e}")

def _log_startup_info():
    """Log startup information. Call after setup_logging() so output goes to log file."""
    print(f"Starting vidcord {CURRENT_VERSION}")
    print("DEBUG: Initial Environment Variables (Relevant):")
    for key in ['LD_LIBRARY_PATH', 'LIBVA_DRIVER_NAME', 'PATH', 'SHELL', 'TERM']:
        val = os.environ.get(key)
        if val:
            print(f"  {key}={val}")


# --- RESOURCE PATH HELPER FUNCTION ---
def resource_path(relative_path):
    """ Get absolute path to resource, works for dev and for PyInstaller """
    try:
        # PyInstaller creates a temp folder and stores path in _MEIPASS
        base_path = sys._MEIPASS
    except Exception:
        # If not running in onefile mode, check if we are frozen (onedir)
        if getattr(sys, 'frozen', False):
            base_path = os.path.dirname(sys.executable)
            # Check if we are in a macOS app bundle and the resource is in Resources
            resources_path = os.path.join(base_path, '..', 'Resources', relative_path)
            if os.path.exists(resources_path):
                return resources_path
        else:
            base_path = os.path.abspath(".")

    return os.path.join(base_path, relative_path)


def _get_temp_dir():
    """Get the platform-appropriate temp directory for vidcord."""
    if platform.system() == 'Windows':
        appdata_path = os.getenv('APPDATA')
        return os.path.join(appdata_path, 'vidcord')
    else:
        return os.path.join(os.path.expanduser('~'), '.vidcord')



class SettingsManager:
    def __init__(self):
        self.settings_file = self._get_settings_file_path()
        self.settings = self._load_settings()

    def _get_settings_file_path(self):
        if platform.system() == 'Windows':
            return os.path.join(os.getenv('APPDATA'), 'vidcord_settings.json')
        else:
            return os.path.join(os.path.expanduser('~'), '.vidcord_settings.json')

    def _load_settings(self):
        if os.path.exists(self.settings_file):
            try:
                with open(self.settings_file, 'r') as file:
                    return json.load(file)
            except Exception:
                return {}
        return {}

    def save_settings(self, settings_dict):
        self.settings.update(settings_dict)
        try:
            # Atomic write: write to temp file then rename to prevent corruption
            dir_name = os.path.dirname(self.settings_file)
            fd, tmp_path = tempfile.mkstemp(dir=dir_name, suffix='.tmp')
            with os.fdopen(fd, 'w') as tmp_file:
                json.dump(self.settings, tmp_file)
            # os.replace is atomic on most file systems
            os.replace(tmp_path, self.settings_file)
        except Exception as e:
            print(f"Failed to save settings: {e}")
            # Clean up temp file on failure
            try:
                if 'tmp_path' in locals() and os.path.exists(tmp_path):
                    os.remove(tmp_path)
            except Exception:
                pass

    def get(self, key, default=None):
        return self.settings.get(key, default)

class VideoProcessor:
    _gpu_cache = None
    _vaapi_cache = None
    _vaapi_cache_set = False
    _ffmpeg_path_configured = False

    @staticmethod
    def setup_ffmpeg_path():
        """
        Detects and configures the PATH for ffmpeg.
        This is moved from global scope to here to be run in a background thread.
        """
        if VideoProcessor._ffmpeg_path_configured:
            return
        # Add bin directory to PATH for ffmpeg/ffprobe
        if getattr(sys, 'frozen', False):
            # In onedir mode, binaries are in the bundle dir or a subdir
            bundle_dir = os.path.dirname(sys.executable)
            
            # Check multiple possible locations for bin
            possible_bin_dirs = [
                os.path.join(bundle_dir, 'bin'), # Standard PyInstaller
                os.path.join(bundle_dir, '..', 'Resources', 'bin'), # macOS .app structure
                os.path.join(bundle_dir, '..', 'Frameworks', 'bin'), # PyInstaller .app structure
                os.path.join(bundle_dir) # Root
            ]
            
            # On macOS, if we are not frozen (running from source) or if bundled ffmpeg fails, 
            # we should also check common Homebrew/system paths
            if platform.system() == 'Darwin':
                possible_bin_dirs.extend(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'])
            
            # On Linux, PyInstaller builds often expect system ffmpeg
            if platform.system() == 'Linux':
                possible_bin_dirs.extend(['/usr/bin', '/usr/local/bin', '/snap/bin'])

            def is_ffmpeg_functional(ffmpeg_path):
                try:
                    # Check if it even exists first
                    if not os.path.exists(ffmpeg_path):
                        return False
                    # Try running it with a simple flag that doesn't do much but checks dynamic linking
                    result = subprocess.run([ffmpeg_path, '-version'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    return result.returncode == 0
                except Exception:
                    return False

            bin_dir_found = False
            for bin_dir in possible_bin_dirs:
                ffmpeg_candidate = os.path.join(bin_dir, 'ffmpeg' + ('.exe' if platform.system() == 'Windows' else ''))
                if is_ffmpeg_functional(ffmpeg_candidate):
                    # Prepend to PATH so it's found first
                    os.environ["PATH"] = bin_dir + os.pathsep + os.environ["PATH"]
                    bin_dir_found = True
                    # print(f"Found functional ffmpeg at: {ffmpeg_candidate}") # Debug
                    break
                    
            if not bin_dir_found:
                print("WARNING: Could not find working ffmpeg. Hardware encoders may not be detected.")
        else:
            # If running from source, also try to find system ffmpeg
            if platform.system() == 'Darwin':
                system_paths = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
                for p in system_paths:
                    if os.path.exists(os.path.join(p, 'ffmpeg')):
                        os.environ["PATH"] = p + os.pathsep + os.environ["PATH"]
                        break
        VideoProcessor._ffmpeg_path_configured = True

    @staticmethod
    def get_system_gpus():
        if VideoProcessor._gpu_cache is not None:
            return VideoProcessor._gpu_cache

        gpus = {'nvidia': False, 'amd': False, 'intel': False, 'apple': False}
        
        try:
            if platform.system() == 'Darwin':
                # macOS
                cmd = ['system_profiler', 'SPDisplaysDataType']
                output = subprocess.check_output(cmd).decode('utf-8').lower()
                if 'nvidia' in output: gpus['nvidia'] = True
                if 'amd' in output or 'radeon' in output: gpus['amd'] = True
                if 'intel' in output: gpus['intel'] = True
                if 'apple' in output or 'm1' in output or 'm2' in output or 'm3' in output or 'm4' in output: gpus['apple'] = True
                
            elif platform.system() == 'Windows':
                # Windows - use PowerShell instead of deprecated wmic for reliability
                try:
                    cmd = ['powershell', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name']
                    output = subprocess.check_output(cmd, creationflags=subprocess.CREATE_NO_WINDOW).decode('utf-8').lower()
                    if 'nvidia' in output: gpus['nvidia'] = True
                    if 'amd' in output or 'radeon' in output: gpus['amd'] = True
                    if 'intel' in output: gpus['intel'] = True
                except Exception:
                    # Fallback to wmic if powershell fails or isn't behaving
                    try:
                        cmd = 'wmic path win32_VideoController get name'
                        output = subprocess.check_output(cmd, shell=True, creationflags=subprocess.CREATE_NO_WINDOW).decode('utf-8').lower()
                        if 'nvidia' in output: gpus['nvidia'] = True
                        if 'amd' in output or 'radeon' in output: gpus['amd'] = True
                        if 'intel' in output: gpus['intel'] = True
                    except Exception:
                        pass # General fallback below handles this
                
            else:
                # Linux
                try:
                    cmd = ['lspci']
                    output = subprocess.check_output(cmd)
                    if isinstance(output, bytes):
                        output = output.decode('utf-8')
                    output = output.lower()
                    for line in output.split('\n'):
                        if 'vga' in line or 'display' in line or '3d' in line:
                            if 'nvidia' in line: gpus['nvidia'] = True
                            if 'amd' in line or 'radeon' in line: gpus['amd'] = True
                            if 'intel' in line: gpus['intel'] = True
                except Exception as e:
                    print(f"Linux GPU detection failed: {e}")
                    # Fallback to False for safety if lspci fails
                    return {'nvidia': False, 'amd': False, 'intel': False, 'apple': False}
            
        except Exception as e:
            print(f"GPU detection failed: {e}")
            # If detection fails, return all true to avoid hiding valid encoders
            VideoProcessor._gpu_cache = {'nvidia': True, 'amd': True, 'intel': True, 'apple': True}
            return VideoProcessor._gpu_cache
            
        VideoProcessor._gpu_cache = gpus
        return gpus

    @staticmethod
    def get_ffmpeg_env():
        """
        Returns a copy of os.environ with adjustments for FFmpeg:
        - Linux + AMD: Force LIBVA_DRIVER_NAME=radeonsi to fix 'Cannot allocate memory' error.
        """
        env = os.environ.copy()
        if platform.system() == 'Linux':
            # We need to detect GPUs without recursion. get_system_gpus calls lspci.
            # Assuming lspci doesn't need special env vars.
            try:
                gpus = VideoProcessor.get_system_gpus()
                if gpus['amd']:
                    # Only set if not already set, or force it? 
                    # forcing it is safer for this specific fix.
                    if env.get('LIBVA_DRIVER_NAME') != 'radeonsi':
                        print("DEBUG: Force-setting LIBVA_DRIVER_NAME=radeonsi for AMD VAAPI")
                        env['LIBVA_DRIVER_NAME'] = 'radeonsi'
            except Exception as e:
                print(f"DEBUG: Failed to setup FFmpeg env: {e}")
        return env

    @staticmethod
    def get_vaapi_device():
        """Find the best functioning VAAPI render node on Linux"""
        if platform.system() != 'Linux':
            return None
        
        # Return cached result if available
        if VideoProcessor._vaapi_cache_set:
            return VideoProcessor._vaapi_cache
            
        render_nodes = []
        try:
            if os.path.exists('/dev/dri'):
                for entry in os.listdir('/dev/dri'):
                    if entry.startswith('renderD'):
                        render_nodes.append(os.path.join('/dev/dri', entry))
            
            # Helper to check if a device actually works with ffmpeg
            def is_device_working(path):
                try:
                    # Try to initialize the device. 
                    # We use -version as a no-op command that still triggers device init when -init_hw_device is passed.
                    cmd = ['ffmpeg', '-y', '-hide_banner', '-init_hw_device', f'vaapi=va:{path}', '-filter_hw_device', 'va', '-f', 'lavfi', '-i', 'nullsrc=s=64x64', '-frames:v', '1', '-f', 'null', '-']
                    # Using a minimal filter graph is more robust than just -version for some drivers
                    
                    result = subprocess.run(
                        cmd, 
                        stdout=subprocess.DEVNULL, 
                        stderr=subprocess.PIPE, 
                        text=True
                    )
                    
                    if result.returncode == 0:
                        return True
                        
                    # Check for specific memory errors which indicate driver issues
                    if "Cannot allocate memory" in result.stderr:
                         print(f"DEBUG: VAAPI OOM on {path}: {result.stderr.splitlines()[-1] if result.stderr else 'Unknown'}")
                         
                    return False
                except Exception as e:
                    print(f"DEBUG: Error checking VAAPI device {path}: {e}")
                    return False

            # Sort: usage of renderD128 is standard preference
            render_nodes.sort(key=lambda x: 'renderD128' not in x)

            for node in render_nodes:
                if is_device_working(node):
                    print(f"DEBUG: Found working VAAPI device: {node}")
                    VideoProcessor._vaapi_cache = node
                    VideoProcessor._vaapi_cache_set = True
                    return node
            
            print("DEBUG: No working VAAPI devices found.")
            
        except Exception as e:
            print(f"Error scanning for VAAPI devices: {e}")
        
        VideoProcessor._vaapi_cache = None
        VideoProcessor._vaapi_cache_set = True
        return None

    @staticmethod
    def get_available_encoders():
        try:
            # -encoders output shows encoders with their type (V=Video, etc)
            # Example: V..... libx264             libx264 H.264 / AVC / MPEG-4 AVC / ICTCP (codec h264)
            result = subprocess.run(
                ['ffmpeg', '-hide_banner', '-encoders'],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                env=VideoProcessor.get_ffmpeg_env()
            )
            encoders_output = result.stdout
            
            # Print for debugging in the log file
            print(f"DEBUG: Found {len(encoders_output.splitlines())} encoder lines in FFmpeg output")
        except FileNotFoundError:
            print("DEBUG: ffmpeg binary not found.")
            return []
        except Exception as e:
            print(f"DEBUG: Error running ffmpeg for detection: {e}")
            return []

        try:
            gpus = VideoProcessor.get_system_gpus()
            
            # Define all potential encoders and their readable labels
            potential_encoders = {
                'libx264': 'CPU (libx264)',
                'h264_nvenc': 'NVIDIA (h264_nvenc)',
                'h264_amf': 'AMD (h264_amf)',
                'h264_qsv': 'Intel (h264_qsv)',
                'h264_vaapi': 'Linux Hardware (h264_vaapi)',
                'h264_videotoolbox': 'Apple Silicon (h264_videotoolbox)' if gpus.get('apple') else 'Hardware (h264_videotoolbox)'
            }
            
            available_encoders = []
            system = platform.system()
            
            # Parse FFmpeg output using regex for more reliability across platforms/ffmpeg versions
            ffmpeg_encoders = set()
            # Pattern: Start of line, 'V' flag, optional other flags, whitespace, encoder name
            regex = re.compile(r'^\s*V[A-Z.]*\s+([a-zA-Z0-9_]+)\s+')
            
            for line in encoders_output.splitlines():
                match = regex.match(line)
                if match:
                    encoder_name = match.group(1)
                    ffmpeg_encoders.add(encoder_name)

            for encoder, label in potential_encoders.items():
                # Check if this encoder makes sense for the current platform/hardware
                should_check = False
                
                if encoder == 'libx264':
                    should_check = True
                elif encoder == 'h264_nvenc' and gpus['nvidia']:
                    should_check = True
                elif encoder == 'h264_amf' and gpus['amd']:
                    # AMF is valid on Linux too (via amdgpu-pro or specialized mesas)
                    should_check = True
                elif encoder == 'h264_qsv' and gpus['intel']:
                    should_check = True
                elif encoder == 'h264_vaapi' and system == 'Linux':
                    # verify actually working
                    if VideoProcessor.get_vaapi_device():
                        should_check = True
                elif encoder == 'h264_videotoolbox' and system == 'Darwin':
                    should_check = True

                if should_check:
                    if (encoder == 'h264_vaapi' and system == 'Linux') or encoder == 'libx264' or encoder in ffmpeg_encoders:
                        available_encoders.append((encoder, label))
                        
            if not any(e[0].endswith('_vaapi') for e in available_encoders) and system == 'Linux':
                print("DEBUG: No VAAPI encoders found in Linux. Raw output first 1000 chars:")
                print(encoders_output[:1000])
                        
            return available_encoders
        except Exception as e:
            print(f"DEBUG: Critical error in get_available_encoders parsing: {e}")
            import traceback
            traceback.print_exc()
            return []

    @staticmethod
    def calculate_bitrate(target_size_mb, duration_sec, audio_bitrate=128, remove_audio=False):
        target_size_kb = target_size_mb * 1024 * 8
        if remove_audio:
            audio_bitrate_kb = 0
        else:
            audio_bitrate_kb = audio_bitrate * duration_sec
        
        video_bitrate = (target_size_kb - audio_bitrate_kb) / duration_sec
        # Ensure minimum bitrate of 100kbps to prevent "Conversion failed" for long videos
        return max(100, int(video_bitrate * 0.9))

    @staticmethod
    def probe_video(file_path):
        try:
            import ffmpeg
        except ImportError:
            raise RuntimeError("python-ffmpeg package is required but not installed")
        try:
            probe_data = ffmpeg.probe(file_path)
            format_info = probe_data.get('format', {})
            duration = float(format_info.get('duration', 0))
            
            video_stream = next((stream for stream in probe_data.get('streams', []) if stream.get('codec_type') == 'video'), None)
            if not video_stream:
                raise ValueError("No video stream found")
                
            width = int(video_stream.get('width', 0))
            height = int(video_stream.get('height', 0))
            
            bitrate = 0
            if video_stream.get('bit_rate') and video_stream['bit_rate'] != 'N/A':
                bitrate = int(video_stream['bit_rate']) // 1000
            elif format_info.get('bit_rate') and format_info['bit_rate'] != 'N/A':
                bitrate = int(format_info['bit_rate']) // 1000
                
            return {
                'duration': duration,
                'width': width,
                'height': height,
                'bitrate': bitrate
            }
        except ffmpeg.Error as e:
            print(f"FFmpeg probe error: {e.stderr.decode() if e.stderr else str(e)}")
            raise
        except Exception as e:
            print(f"Probe error: {e}")
            raise

    @staticmethod
    def generate_preview(file_path, time_sec):
        vidcord_temp_dir = _get_temp_dir()
        
        os.makedirs(vidcord_temp_dir, exist_ok=True)
        temp_image_path = os.path.join(vidcord_temp_dir, 'preview_frame.jpg')
        
        try:
            ffmpeg_command = [
                "ffmpeg", "-y",
                "-ss", str(time_sec),
                "-i", file_path,
                "-an", "-sn",
                "-frames:v", "1",
                "-q:v", "4",
                "-vf", "scale=320:-1:flags=fast_bilinear",
                temp_image_path
            ]
            subprocess.run(ffmpeg_command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, creationflags=_CREATION_FLAGS, env=VideoProcessor.get_ffmpeg_env())
            return temp_image_path
        except Exception as e:
            print(f"Preview generation failed: {e}")
            return None

class CompressionThread(QThread):
    progress_updated = pyqtSignal(int, str, str) # progress, eta, status
    finished = pyqtSignal(bool, str) # success, message

    def __init__(self, cmd, clip_duration, output_file=None):
        super().__init__()
        self.cmd = cmd
        self.clip_duration = clip_duration
        self.output_file = output_file
        self.is_running = True

    def run(self):
        print(f"DEBUG: Starting encoding with command: {self.cmd}")
        process = subprocess.Popen(self.cmd, stderr=subprocess.PIPE, text=True, universal_newlines=True, creationflags=_CREATION_FLAGS, env=VideoProcessor.get_ffmpeg_env())
        
        encoding_start_time = time.time()
        
        full_log = [] # Capture full log

        while process.poll() is None and self.is_running:
            line = process.stderr.readline()
            if line:
                full_log.append(line.strip())
                # Log "error" or "warning" lines immediately
                if "error" in line.lower() or "warning" in line.lower():
                     print(f"FFMPEG_LOG: {line.strip()}")

                if "time=" in line:
                    try:
                        time_str = line.split("time=")[1].split(" ")[0]
                        if time_str != "N/A":
                            h, m, s = map(float, time_str.split(':'))
                            current_time_sec_processed = h * 3600 + m * 60 + s
                            
                            if self.clip_duration > 0:
                                percent = min((current_time_sec_processed / self.clip_duration) * 100, 100)
                                elapsed_time = time.time() - encoding_start_time
                                
                                eta_str = "Calculating..."
                                if current_time_sec_processed > 0:
                                    eta = (elapsed_time / (current_time_sec_processed / self.clip_duration)) - elapsed_time
                                    eta_str = self.format_time(eta)
                                
                                self.progress_updated.emit(int(percent), eta_str, "Compressing...")
                    except Exception:
                        pass
        
        if not self.is_running:
            print("DEBUG: Encoding cancelled by user.")
            process.terminate()
            # Clean up partial output file
            if self.output_file:
                try:
                    if os.path.exists(self.output_file):
                        os.remove(self.output_file)
                        print(f"DEBUG: Cleaned up partial file: {self.output_file}")
                except Exception:
                    pass
            return
        
        process.wait()
        
        # Read any remaining output
        remaining_stderr = process.stderr.read()
        if remaining_stderr:
            full_log.extend(remaining_stderr.splitlines())

        if process.returncode == 0:
            print("DEBUG: Encoding finished successfully.")
            self.finished.emit(True, "Conversion complete!")
        else:
            print(f"DEBUG: Encoding failed with return code {process.returncode}")
            # Log full stderr for debugging
            print("DEBUG: Full FFmpeg Log:")
            for l in full_log:
                print(f"  {l}")

            # Try to grab the last few lines of stderr for a better error message
            error_msg = "Conversion failed."
            if full_log:
                last_lines = full_log[-5:]
                error_msg += f"\n\nFFmpeg Error:\n" + "\n".join(last_lines)
            
            self.finished.emit(False, error_msg)

    def format_time(self, seconds):
        if seconds < 0: return "Calculating..."
        mins, secs = divmod(int(seconds), 60)
        if mins > 60:
            hours, mins = divmod(mins, 60)
            return f"{hours}h {mins}m {secs}s"
        return f"{mins}m {secs}s"

    def stop(self):
        self.is_running = False

class PreviewThread(QThread):
    preview_ready = pyqtSignal(str) # path to image

    def __init__(self, file_path, time_sec):
        super().__init__()
        self.file_path = file_path
        self.time_sec = time_sec
        self.is_running = True
        self.process = None

    def run(self):
        if not self.is_running: return
        
        # Determine temp path
        vidcord_temp_dir = _get_temp_dir()
        
        os.makedirs(vidcord_temp_dir, exist_ok=True)
        # Use a unique name for this thread's preview
        thread_id = int(time.time() * 1000)
        temp_image_path = os.path.join(vidcord_temp_dir, f'preview_{thread_id}.jpg')

        ffmpeg_command = [
            "ffmpeg", "-y",
            "-ss", str(self.time_sec),
            "-i", self.file_path,
            "-an", "-sn",
            "-frames:v", "1",
            "-q:v", "4",
            "-vf", "scale=320:-1:flags=fast_bilinear",
            temp_image_path
        ]
        
        try:
            self.process = subprocess.Popen(
                ffmpeg_command, 
                stdout=subprocess.DEVNULL, 
                stderr=subprocess.DEVNULL, 
                creationflags=_CREATION_FLAGS,
                env=VideoProcessor.get_ffmpeg_env()
            )
            self.process.wait()
            
            if self.is_running and self.process.returncode == 0:
                self.preview_ready.emit(temp_image_path)
            else:
                if os.path.exists(temp_image_path):
                    try: os.remove(temp_image_path)
                    except Exception: pass
        except Exception as e:
            print(f"Preview thread failed: {e}")

    def stop(self):
        self.is_running = False
        if self.process:
            try:
                self.process.terminate()
            except Exception:
                pass

class EncoderDetectionThread(QThread):
    finished = pyqtSignal(list)

    def run(self):
        print("DEBUG: EncoderDetectionThread started")
        # Ensure ffmpeg is found before detecting encoders
        VideoProcessor.setup_ffmpeg_path()
        try:
            encoders = VideoProcessor.get_available_encoders()
            print(f"DEBUG: EncoderDetectionThread finished with {len(encoders)} encoders")
            self.finished.emit(encoders)
        except Exception as e:
            print(f"DEBUG: EncoderDetectionThread CRASHED: {e}")
            import traceback
            traceback.print_exc()
            self.finished.emit([])

class UpdateCheckThread(QThread):
    update_available = pyqtSignal(str, str)  # latest_version, release_url
    up_to_date = pyqtSignal()
    failed = pyqtSignal(str)

    def __init__(self, current_version, parent=None):
        super().__init__(parent=parent)
        self.current_version = current_version

    def run(self):
        try:
            import requests
            from packaging import version
        except Exception as e:
            self.failed.emit(f"Missing dependencies: {e}")
            return

        api_url = "https://api.github.com/repos/cyroz1/vidcord/releases/latest"
        try:
            response = requests.get(
                api_url,
                timeout=6,
                headers={"Accept": "application/vnd.github+json", "User-Agent": "vidcord-update-check"}
            )
        except Exception as e:
            self.failed.emit(f"Request failed: {e}")
            return

        if response.status_code != 200:
            self.failed.emit(f"HTTP {response.status_code}")
            return

        try:
            data = response.json()
        except Exception as e:
            self.failed.emit(f"Invalid JSON: {e}")
            return

        tag = data.get("tag_name") or data.get("name")
        release_url = data.get("html_url") or "https://github.com/cyroz1/vidcord/releases/latest"
        if not tag:
            self.failed.emit("Missing tag name")
            return

        try:
            current = version.parse(str(self.current_version).lstrip("vV"))
            latest = version.parse(str(tag).lstrip("vV"))
        except Exception as e:
            self.failed.emit(f"Version parse failed: {e}")
            return

        if latest > current:
            self.update_available.emit(str(tag), release_url)
        else:
            self.up_to_date.emit()

class VideoFrameWidget(QWidget):
    def __init__(self, corner_radius=8, parent=None):
        super().__init__(parent=parent)
        self._frame_image = None
        self._corner_radius = corner_radius
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self.setAutoFillBackground(False)

    def setFrameImage(self, image: QImage):
        self._frame_image = image
        self.update()

    def clearFrame(self):
        self._frame_image = None
        self.update()

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, True)
        rect = self.rect()

        path = QPainterPath()
        path.addRoundedRect(QRectF(rect), self._corner_radius, self._corner_radius)
        painter.setClipPath(path)

        if not self._frame_image or self._frame_image.isNull():
            return

        pixmap = QPixmap.fromImage(self._frame_image)
        scaled = pixmap.scaled(rect.size(), Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)
        x = int((rect.width() - scaled.width()) / 2)
        y = int((rect.height() - scaled.height()) / 2)
        painter.drawPixmap(x, y, scaled)

class PreviewWidget(QWidget):
    playRequested = pyqtSignal()
    stopRequested = pyqtSignal()

    def __init__(self, parent=None):
        super().__init__(parent=parent)
        self._play_enabled = False
        self._hovered = False
        self._playing = False
        self._corner_radius = 8
        self._content_aspect = None
        self._content_rect = None
        self.setMouseTracking(True)

        self.image_label = ImageLabel(self)
        self.image_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.image_label.setBorderRadius(self._corner_radius, self._corner_radius, self._corner_radius, self._corner_radius)
        self.image_label.setText("Preview")

        self.video_sink = None
        self.video_frame_widget = None
        self.video_widget = None
        self._video_layer = None
        self._video_output_available = False

        if QVideoSink is not None:
            self.video_sink = QVideoSink(self)
            self.video_frame_widget = VideoFrameWidget(self._corner_radius, self)
            self.video_frame_widget.hide()
            self.video_sink.videoFrameChanged.connect(self._on_video_frame_changed)
            self._video_layer = self.video_frame_widget
            self._video_output_available = True
        elif QVideoWidget is not None:
            self.video_widget = QVideoWidget(self)
            self.video_widget.setStyleSheet("background: transparent; border-radius: 8px;")
            self.video_widget.setAutoFillBackground(False)
            self.video_widget.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
            try:
                self.video_widget.setAspectRatioMode(Qt.AspectRatioMode.KeepAspectRatio)
            except Exception:
                pass
            self.video_widget.hide()
            self._video_layer = self.video_widget
            self._video_output_available = True
        else:
            self._video_layer = QWidget(self)
            self._video_layer.hide()

        self.play_button = self._make_overlay_button()
        self._set_play_button_icon()
        self.play_button.clicked.connect(self.playRequested.emit)
        self.play_button.hide()

        self.stop_button = self._make_overlay_button()
        self._set_stop_button_icon()
        self.stop_button.clicked.connect(self.stopRequested.emit)
        self.stop_button.hide()

        self.controls_container = QWidget(self)
        controls_layout = QHBoxLayout(self.controls_container)
        controls_layout.setContentsMargins(0, 0, 0, 0)
        controls_layout.setSpacing(12)
        controls_layout.addWidget(self.play_button)
        controls_layout.addWidget(self.stop_button)
        self.controls_container.setMouseTracking(True)
        self._controls_spacing = 12
        self._controls_button_size = 48
        self._update_controls_container_size()

        layout = QGridLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        layout.addWidget(self.image_label, 0, 0)
        layout.addWidget(self._video_layer, 0, 0)

        self.image_label.setMouseTracking(True)
        self.image_label.installEventFilter(self)
        self.controls_container.installEventFilter(self)
        self.play_button.setMouseTracking(True)
        self.play_button.installEventFilter(self)
        self.stop_button.setMouseTracking(True)
        self.stop_button.installEventFilter(self)
        if self.video_widget is not None:
            self.video_widget.setMouseTracking(True)
            self.video_widget.installEventFilter(self)
        if self.video_frame_widget is not None:
            self.video_frame_widget.setMouseTracking(True)
            self.video_frame_widget.installEventFilter(self)

        self.controls_container.raise_()
        self._position_controls_container()

    def _make_overlay_button(self):
        button = QToolButton(self)
        button.setCursor(Qt.CursorShape.PointingHandCursor)
        button.setFixedSize(48, 48)
        button.setStyleSheet(
            "QToolButton {"
            "background: qlineargradient(x1:0, y1:0, x2:1, y2:1, "
            "stop:0 rgba(255, 255, 255, 70), stop:1 rgba(255, 255, 255, 30));"
            "border: 1px solid rgba(255, 255, 255, 160);"
            "border-radius: 24px;"
            "color: #ffffff;"
            "}"
            "QToolButton:hover {"
            "background: qlineargradient(x1:0, y1:0, x2:1, y2:1, "
            "stop:0 rgba(255, 255, 255, 110), stop:1 rgba(255, 255, 255, 60));"
            "border: 1px solid rgba(255, 255, 255, 220);"
            "}"
            "QToolButton:pressed {"
            "background: rgba(255, 255, 255, 140);"
            "}"
        )
        return button

    def _set_play_button_icon(self):
        try:
            icon = self._make_play_icon()
            if icon is not None:
                self.play_button.setIcon(icon)
                self.play_button.setIconSize(QSize(24, 24))
                self.play_button.setText("")
                return
        except Exception:
            pass
        self.play_button.setText("Play")

    def _set_stop_button_icon(self):
        try:
            icon = self._make_stop_icon()
            if icon is not None:
                self.stop_button.setIcon(icon)
                self.stop_button.setIconSize(QSize(22, 22))
                self.stop_button.setText("")
                return
        except Exception:
            pass
        self.stop_button.setText("■")

    def _update_controls_container_size(self):
        if self.controls_container is None:
            return
        total_width = (self._controls_button_size * 2) + self._controls_spacing
        total_height = self._controls_button_size
        self.controls_container.setFixedSize(total_width, total_height)

    def _make_play_icon(self):
        size = 24
        pixmap = QPixmap(size, size)
        pixmap.fill(Qt.GlobalColor.transparent)
        painter = QPainter(pixmap)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor(255, 255, 255))
        margin = 6
        path = QPainterPath()
        path.moveTo(margin, margin - 1)
        path.lineTo(size - margin, size / 2)
        path.lineTo(margin, size - margin + 1)
        path.closeSubpath()
        painter.drawPath(path)
        painter.end()
        return QIcon(pixmap)

    def _make_stop_icon(self):
        size = 24
        pixmap = QPixmap(size, size)
        pixmap.fill(Qt.GlobalColor.transparent)
        painter = QPainter(pixmap)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor(255, 255, 255))
        side = 10
        x = (size - side) / 2
        y = (size - side) / 2
        painter.drawRoundedRect(QRectF(x, y, side, side), 1.5, 1.5)
        painter.end()
        return QIcon(pixmap)

    def setPlayEnabled(self, enabled: bool):
        self._play_enabled = enabled
        self._update_controls_visibility()

    def setPlaying(self, playing: bool):
        self._playing = playing
        self._update_controls_visibility()

    def showVideo(self):
        if self._video_layer is not None:
            self._video_layer.show()

    def showImage(self):
        if self._video_layer is not None:
            self._video_layer.hide()
        if self.video_frame_widget is not None:
            self.video_frame_widget.clearFrame()
        self.image_label.show()

    def setPixmap(self, pixmap: QPixmap):
        self.image_label.setPixmap(pixmap)
        if pixmap is not None and not pixmap.isNull():
            self._set_content_aspect(pixmap.width(), pixmap.height())

    def setText(self, text: str):
        self.image_label.setText(text)

    def imageSize(self):
        return self.image_label.size()

    def setContentAspectRatio(self, width: int, height: int):
        self._set_content_aspect(width, height)

    def hasVideoOutput(self):
        return self._video_output_available

    def videoOutputTarget(self):
        if self.video_sink is not None:
            return ("sink", self.video_sink)
        if self.video_widget is not None:
            return ("widget", self.video_widget)
        return (None, None)

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self._update_rounded_masks()
        self._update_content_rect()
        self._position_controls_container()

    def _update_rounded_masks(self):
        if self.image_label is not None:
            rect = self.image_label.rect()
            if rect.width() > 0 and rect.height() > 0:
                path = QPainterPath()
                path.addRoundedRect(QRectF(rect), self._corner_radius, self._corner_radius)
                region = QRegion(path.toFillPolygon().toPolygon())
                self.image_label.setMask(region)

        if self.video_widget is not None:
            rect = self.video_widget.rect()
            if rect.width() > 0 and rect.height() > 0:
                path = QPainterPath()
                path.addRoundedRect(QRectF(rect), self._corner_radius, self._corner_radius)
                region = QRegion(path.toFillPolygon().toPolygon())
                self.video_widget.setMask(region)

    def _set_content_aspect(self, width: int, height: int):
        if width and height and width > 0 and height > 0:
            self._content_aspect = float(width) / float(height)
        else:
            self._content_aspect = None
        self._update_content_rect()
        self._position_controls_container()

    def _update_content_rect(self):
        if self._content_aspect is None or self.image_label is None:
            self._content_rect = None
            return
        rect = self.image_label.rect()
        if rect.width() <= 0 or rect.height() <= 0:
            self._content_rect = None
            return

        available_w = rect.width()
        available_h = rect.height()
        if available_w / available_h >= self._content_aspect:
            draw_h = available_h
            draw_w = available_h * self._content_aspect
        else:
            draw_w = available_w
            draw_h = available_w / self._content_aspect
        x = (available_w - draw_w) / 2
        y = (available_h - draw_h) / 2
        self._content_rect = QRectF(x, y, draw_w, draw_h)
        self._position_controls_container()

    def _controls_rect_in_label(self):
        if self.controls_container is None or self.image_label is None:
            return None
        global_top_left = self.controls_container.mapToGlobal(QPoint(0, 0))
        label_top_left = self.image_label.mapFromGlobal(global_top_left)
        return QRectF(
            label_top_left.x(),
            label_top_left.y(),
            self.controls_container.width(),
            self.controls_container.height()
        )

    def _position_controls_container(self):
        if self.controls_container is None or self.image_label is None:
            return
        self._update_controls_container_size()
        container_size = self.controls_container.size()

        if self._content_rect is None:
            target_rect = QRectF(self.rect())
        else:
            label_geo = self.image_label.geometry()
            target_rect = QRectF(
                label_geo.x() + self._content_rect.x(),
                label_geo.y() + self._content_rect.y(),
                self._content_rect.width(),
                self._content_rect.height()
            )

        center_x = target_rect.x() + (target_rect.width() / 2)
        center_y = target_rect.y() + (target_rect.height() / 2)
        x = center_x - (container_size.width() / 2)
        y = center_y - (container_size.height() / 2)

        x = max(target_rect.left(), min(x, target_rect.right() - container_size.width()))
        y = max(target_rect.top(), min(y, target_rect.bottom() - container_size.height()))

        self.controls_container.setGeometry(
            int(x), int(y), int(container_size.width()), int(container_size.height())
        )

    def _is_point_over_content(self, point):
        if point is None:
            return True
        if self._content_rect is None:
            return True
        if isinstance(point, QPoint):
            point = QPointF(point)
        if self._content_rect.contains(point):
            return True
        controls_rect = self._controls_rect_in_label()
        if controls_rect is None:
            return False
        return controls_rect.contains(point)

    def _on_video_frame_changed(self, frame):
        if self.video_frame_widget is None:
            return
        try:
            if frame is None:
                return
            if hasattr(frame, "isValid") and not frame.isValid():
                return
            if hasattr(frame, "toImage"):
                image = frame.toImage()
            elif hasattr(frame, "image"):
                image = frame.image()
            else:
                return
            if image is None or image.isNull():
                return
            self._set_content_aspect(image.width(), image.height())
            self.video_frame_widget.setFrameImage(image)
        except Exception:
            pass

    def _map_event_pos_to_label(self, obj, pos):
        if pos is None or self.image_label is None:
            return None
        if obj is self.image_label:
            if isinstance(pos, QPoint):
                return QPointF(pos)
            return pos
        if isinstance(pos, QPointF):
            point = QPoint(int(pos.x()), int(pos.y()))
        elif isinstance(pos, QPoint):
            point = pos
        else:
            return None
        mapped = self.image_label.mapFrom(obj, point)
        return QPointF(mapped)

    def _update_hover_from_global(self):
        if self.image_label is None:
            self._hovered = False
            return
        global_pos = QCursor.pos()
        label_pos = self.image_label.mapFromGlobal(global_pos)
        self._hovered = self._is_point_over_content(QPointF(label_pos))

    def eventFilter(self, obj, event):
        etype = event.type()
        if etype in (QEvent.Type.MouseMove, QEvent.Type.HoverMove, QEvent.Type.Enter, QEvent.Type.Leave):
            self._update_hover_from_global()
            self._update_controls_visibility()
        return super().eventFilter(obj, event)

    def mouseMoveEvent(self, event):
        self._update_hover_from_global()
        self._update_controls_visibility()
        return super().mouseMoveEvent(event)

    def enterEvent(self, event):
        self._update_hover_from_global()
        self._update_controls_visibility()
        return super().enterEvent(event)

    def leaveEvent(self, event):
        self._hovered = False
        self._update_controls_visibility()
        return super().leaveEvent(event)

    def _update_controls_visibility(self):
        self._position_controls_container()
        show_play = self._play_enabled and self._hovered and not self._playing
        show_stop = self._play_enabled and self._hovered and self._playing
        self.play_button.setVisible(show_play)
        self.stop_button.setVisible(show_stop)

class VidCordInterface(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent=parent)
        self.setObjectName("vidCordInterface")
        self.file_path = None
        self.settings_manager = SettingsManager()
        self.video_processor = VideoProcessor
        
        self.probed_data = {}
        self.duration_for_slider = 0
        
        self.previewUpdateTimer = QTimer(self)
        self.previewUpdateTimer.setSingleShot(True)
        self.previewUpdateTimer.timeout.connect(self._actualUpdatePreview)
        self.previewDebounceTime = 150
        self.lastSliderValueForPreview = 0.0
        
        self.initUI()
        self.checkForUpdates()

        self.preview_thread = None
        self.active_preview_threads = set()

        self.previewPlayer = None
        self.previewAudioOutput = None
        if MULTIMEDIA_AVAILABLE and QMediaPlayer is not None and QAudioOutput is not None:
            self.previewPlayer = QMediaPlayer(self)
            self.previewAudioOutput = QAudioOutput(self)
            self.previewAudioOutput.setVolume(1.0)
            self.previewPlayer.setAudioOutput(self.previewAudioOutput)
            self.previewPlayer.mediaStatusChanged.connect(self._onPreviewMediaStatusChanged)
            self.previewPlayer.positionChanged.connect(self._onPreviewPositionChanged)
            self.previewPlayer.playbackStateChanged.connect(self._onPreviewPlaybackStateChanged)
            try:
                self.previewPlayer.errorOccurred.connect(self._onPreviewPlaybackError)
            except Exception:
                pass
        self.previewEndMs = None
        self.previewStartMs = None
        self.previewPendingSeek = False
        self.update_thread = None


    def initUI(self):
        self.setAcceptDrops(True)
        self.main_layout = QVBoxLayout()
        self.main_layout.setSpacing(16)
        self.main_layout.setContentsMargins(24, 24, 24, 24)

        # Title / Header
        header_container = QWidget()
        header_layout = QHBoxLayout(header_container)
        header_layout.setAlignment(Qt.AlignmentFlag.AlignCenter)
        header_layout.setContentsMargins(0, 0, 0, 0)
        
        # Use resource_path for the icon
        icon_path = resource_path('icon.ico')
        if not os.path.exists(icon_path):
            icon_path = resource_path('icon.png')
        self.icon_label = ImageLabel(icon_path, self)
        self.icon_label.setFixedSize(42, 42)
        self.icon_label.setBorderRadius(4, 4, 4, 4)
        self.icon_label.setScaledContents(True)
        
        title = TitleLabel("vidcord", self)
        
        header_layout.addWidget(self.icon_label)
        header_layout.addSpacing(12)
        header_layout.addWidget(title)
        
        self.main_layout.addWidget(header_container)

        # File Selection
        file_frame = CardWidget(self)
        file_layout = QVBoxLayout(file_frame)
        
        self.label = BodyLabel('Drag a video file here or click to browse', self)
        self.label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        file_layout.addWidget(self.label)
        
        self.openButton = PushButton('Browse File', self)
        self.openButton.setIcon(FIF.FOLDER)
        self.openButton.clicked.connect(self.openFileDialog)
        file_layout.addWidget(self.openButton)
        self.main_layout.addWidget(file_frame)

        # Settings Area
        self.basicSettingsContainer = QWidget(self)
        settings_layout = QHBoxLayout(self.basicSettingsContainer)
        settings_layout.setContentsMargins(0, 0, 0, 0)
        
        self.qualityComboBox = ComboBox(self)
        self.qualityComboBox.addItems([p['label'] for p in QUALITY_PRESETS])
        settings_layout.addWidget(BodyLabel("Target:", self))
        settings_layout.addWidget(self.qualityComboBox)
        
        self.encoderComboBox = ComboBox(self)
        self.encoderComboBox.addItem("CPU (libx264)")
        self.encoder_mapping = {"CPU (libx264)": "libx264"}
        settings_layout.addWidget(BodyLabel("Encoder:", self))
        settings_layout.addWidget(self.encoderComboBox)
        
        self.main_layout.addWidget(self.basicSettingsContainer)

        self.advancedSettingsContainer = QWidget(self)
        advanced_controls_layout = QHBoxLayout(self.advancedSettingsContainer)
        advanced_controls_layout.setContentsMargins(0, 0, 0, 0)
        advanced_controls_layout.setSpacing(4)

        self.advancedTargetSizeInput = QLineEdit(self)
        self.advancedTargetSizeInput.setPlaceholderText("MB")
        size_validator = QDoubleValidator(0.1, 100000.0, 2, self)
        size_validator.setNotation(QDoubleValidator.Notation.StandardNotation)
        self.advancedTargetSizeInput.setValidator(size_validator)
        self.advancedTargetSizeInput.setFixedWidth(90)

        self.advancedResolutionComboBox = ComboBox(self)
        self.advancedResolutionComboBox.addItems(["Native", "4K", "1440p", "1080p", "720p", "480p"])
        self.advancedResolutionComboBox.setFixedWidth(110)

        self.advancedEncoderInput = QLineEdit(self)
        self.advancedEncoderInput.setPlaceholderText("e.g. libx264")
        self.advancedEncoderInput.setFixedWidth(140)

        self.advancedEncodersInfoButton = QToolButton(self)
        self.advancedEncodersInfoButton.setIcon(
            self.style().standardIcon(QStyle.StandardPixmap.SP_MessageBoxInformation)
        )
        self.advancedEncodersInfoButton.setToolTip("Show ffmpeg encoders")
        self.advancedEncodersInfoButton.setCursor(Qt.CursorShape.PointingHandCursor)
        self.advancedEncodersInfoButton.setAutoRaise(True)
        self.advancedEncodersInfoButton.setFixedSize(22, 22)

        advanced_controls_layout.addWidget(BodyLabel("Size (MB):", self))
        advanced_controls_layout.addWidget(self.advancedTargetSizeInput)
        advanced_controls_layout.addSpacing(4)
        advanced_controls_layout.addWidget(BodyLabel("Resolution:", self))
        advanced_controls_layout.addWidget(self.advancedResolutionComboBox)
        advanced_controls_layout.addSpacing(4)
        advanced_controls_layout.addWidget(BodyLabel("Encoder:", self))
        advanced_controls_layout.addWidget(self.advancedEncoderInput)
        advanced_controls_layout.addWidget(self.advancedEncodersInfoButton)
        advanced_controls_layout.addStretch()

        self.advancedSettingsContainer.setVisible(False)
        self.main_layout.addWidget(self.advancedSettingsContainer)

        # Start hardware detection in background
        self.detection_thread = EncoderDetectionThread()
        self.detection_thread.finished.connect(self.onEncodersDetected)
        self.detection_thread.start()

        # Additional Options
        options_layout = QHBoxLayout()
        self.removeAudioCheck = CheckBox("Remove Audio", self)
        options_layout.addWidget(self.removeAudioCheck)
        options_layout.addStretch()
        self.main_layout.addLayout(options_layout)

        # Trimming
        trim_layout = QVBoxLayout()
        trim_layout.addWidget(SubtitleLabel("Trim Video:", self))
        
        sliders_layout = QHBoxLayout()
        self.startTimeSlider = Slider(Qt.Orientation.Horizontal, self)
        self.startTimeSlider.setRange(0, 1000)
        self.endTimeSlider = Slider(Qt.Orientation.Horizontal, self)
        self.endTimeSlider.setRange(0, 1000)
        self.endTimeSlider.setValue(1000)
        
        sliders_layout.addWidget(BodyLabel("Start", self))
        sliders_layout.addWidget(self.startTimeSlider)
        sliders_layout.addWidget(BodyLabel("End", self))
        sliders_layout.addWidget(self.endTimeSlider)
        trim_layout.addLayout(sliders_layout)
        
        time_labels_layout = QHBoxLayout()
        self.startLabel = CaptionLabel('0.0s', self)
        self.endLabel = CaptionLabel('0.0s', self)
        time_labels_layout.addWidget(self.startLabel)
        time_labels_layout.addStretch()
        time_labels_layout.addWidget(self.endLabel)
        trim_layout.addLayout(time_labels_layout)
        
        self.main_layout.addLayout(trim_layout)

        # Preview
        self.videoPreview = PreviewWidget(self)
        self.videoPreview.setFixedHeight(200)
        self.videoPreview.playRequested.connect(self.playPreviewSegment)
        self.videoPreview.stopRequested.connect(self.stopPreviewPlayback)
        if not MULTIMEDIA_AVAILABLE or not self.videoPreview.hasVideoOutput():
            self.videoPreview.setPlayEnabled(False)
        self.main_layout.addWidget(self.videoPreview)

        # Action
        self.convertButton = PrimaryPushButton('Compress Video', self)
        self.convertButton.setIcon(FIF.VIDEO)
        self.convertButton.setFixedHeight(40)
        self.convertButton.clicked.connect(self.convertVideoFromButton)
        self.main_layout.addWidget(self.convertButton)

        # Progress
        self.progressLayout = QVBoxLayout()
        self.progressBar = ProgressBar(self)
        self.progressBar.setRange(0, 100)
        self.progressLayout.addWidget(self.progressBar)
        self.etaLabel = CaptionLabel("Ready", self)
        self.etaLabel.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.progressLayout.addWidget(self.etaLabel)
        self.main_layout.addLayout(self.progressLayout)

        # Footer
        footer_layout = QHBoxLayout()
        footer_layout.setSpacing(5)
        
        version_label = CaptionLabel(CURRENT_VERSION, self)
        
        # GitHub Link
        self.github_link = HyperlinkButton(
            url='https://github.com/cyroz1/vidcord', 
            text='GitHub', 
            parent=self
        )
        
        self.advancedModeCheck = CheckBox("Advanced Mode", self)
        
        footer_layout.addWidget(version_label)
        footer_layout.addWidget(self.github_link)
        footer_layout.addStretch()
        footer_layout.addWidget(self.advancedModeCheck)
        footer_layout.setAlignment(self.advancedModeCheck, Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        footer_layout.setContentsMargins(0, 0, 0, 6)
        
        self.main_layout.addLayout(footer_layout)

        self.setLayout(self.main_layout)
        
        self.startTimeSlider.valueChanged.connect(self.updateStartTime)
        self.endTimeSlider.valueChanged.connect(self.updateEndTime)
        self.loadPreviousSelections()
        self._applyAdvancedModeState(self.advancedModeCheck.isChecked(), save_settings=False)

        self.qualityComboBox.currentIndexChanged.connect(self.saveCurrentSelections)
        self.encoderComboBox.currentIndexChanged.connect(self.saveCurrentSelections)
        self.advancedModeCheck.toggled.connect(self.onAdvancedModeToggled)
        self.advancedTargetSizeInput.editingFinished.connect(self.saveCurrentSelections)
        self.advancedResolutionComboBox.currentIndexChanged.connect(self.saveCurrentSelections)
        self.advancedEncoderInput.editingFinished.connect(self.saveCurrentSelections)
        self.advancedEncodersInfoButton.clicked.connect(self.showFfmpegEncoders)

    def onEncodersDetected(self, encoders):
        # Prevent recursive updates and save current selection
        current_encoder_text = self.encoderComboBox.currentText()
        saved_encoder_label = self.settings_manager.get("encoder_label")
        
        # Block signals to avoid triggering saveCurrentSelections
        self.encoderComboBox.blockSignals(True)
        self.encoderComboBox.clear()
        self.encoder_mapping = {label: encoder for encoder, label in encoders}
        for _, label in encoders:
            self.encoderComboBox.addItem(label)
            
        # 1. Prefer saved setting if it exists in the new list
        if saved_encoder_label:
            index = self.encoderComboBox.findText(saved_encoder_label)
            if index >= 0:
                self.encoderComboBox.setCurrentIndex(index)
                self.encoderComboBox.blockSignals(False)
                return

        # 2. Fallback to current text if it's not the placeholder or matches something
        index = self.encoderComboBox.findText(current_encoder_text)
        if index >= 0:
            self.encoderComboBox.setCurrentIndex(index)
        else:
            # 3. Last fallback: load by index if no label match
            encoder_index = self.settings_manager.get("encoder_index", 0)
            if encoder_index < self.encoderComboBox.count():
                self.encoderComboBox.setCurrentIndex(encoder_index)
        
        self.encoderComboBox.blockSignals(False)

    def checkForUpdates(self):
        # Avoid excessive checks
        last_check = self.settings_manager.get("update_last_check", 0)
        if time.time() - last_check < 6 * 60 * 60:
            return

        self.settings_manager.save_settings({"update_last_check": time.time()})

        if self.update_thread and self.update_thread.isRunning():
            return

        self.update_thread = UpdateCheckThread(CURRENT_VERSION, self)
        self.update_thread.update_available.connect(self.onUpdateAvailable)
        self.update_thread.failed.connect(self.onUpdateCheckFailed)
        self.update_thread.start()

    def onUpdateAvailable(self, latest_version, release_url):
        InfoBar.info(
            title='Update Available',
            content=f"Version {latest_version} is available on GitHub Releases.",
            orient=Qt.Orientation.Horizontal,
            isClosable=True,
            position=InfoBarPosition.TOP,
            duration=8000,
            parent=self
        )

    def onUpdateCheckFailed(self, reason):
        # Silently log failures to avoid noisy UI
        print(f"Update check failed: {reason}")

    def loadPreviousSelections(self):
        quality_index = self.settings_manager.get("quality_index", 0)
        self.qualityComboBox.setCurrentIndex(quality_index)
        
        # Try loading by label first
        encoder_label = self.settings_manager.get("encoder_label")
        if encoder_label:
            index = self.encoderComboBox.findText(encoder_label)
            if index >= 0:
                self.encoderComboBox.setCurrentIndex(index)
                return

        # Fallback to index
        encoder_index = self.settings_manager.get("encoder_index", 0)
        if encoder_index < self.encoderComboBox.count():
            self.encoderComboBox.setCurrentIndex(encoder_index)

        # Advanced settings
        advanced_enabled = self.settings_manager.get("advanced_mode", False)
        self.advancedModeCheck.setChecked(advanced_enabled)

        advanced_target_size = self.settings_manager.get("advanced_target_size", "")
        if advanced_target_size:
            self.advancedTargetSizeInput.setText(str(advanced_target_size))

        advanced_resolution = self.settings_manager.get("advanced_resolution", "Native")
        resolution_index = self.advancedResolutionComboBox.findText(advanced_resolution)
        if resolution_index >= 0:
            self.advancedResolutionComboBox.setCurrentIndex(resolution_index)

        advanced_encoder = self.settings_manager.get("advanced_encoder", "")
        if advanced_encoder:
            self.advancedEncoderInput.setText(str(advanced_encoder))

    def saveCurrentSelections(self, index=None):
        self.settings_manager.save_settings({
            "quality_index": self.qualityComboBox.currentIndex(),
            "encoder_index": self.encoderComboBox.currentIndex(),
            "encoder_label": self.encoderComboBox.currentText(),
            "advanced_mode": self.advancedModeCheck.isChecked(),
            "advanced_target_size": self.advancedTargetSizeInput.text().strip(),
            "advanced_resolution": self.advancedResolutionComboBox.currentText(),
            "advanced_encoder": self.advancedEncoderInput.text().strip()
        })

    def _applyAdvancedModeState(self, enabled, save_settings=True):
        self.advancedSettingsContainer.setVisible(enabled)
        self.basicSettingsContainer.setVisible(not enabled)
        if save_settings:
            self.saveCurrentSelections()

    def onAdvancedModeToggled(self, enabled):
        self._applyAdvancedModeState(enabled, save_settings=True)

    def _resolutionChoiceToShortSide(self, choice):
        normalized = choice.strip().lower()
        if normalized in ("native", "native res", "native resolution"):
            return None
        mapping = {
            "4k": 2160,
            "2160p": 2160,
            "1440p": 1440,
            "1080p": 1080,
            "720p": 720,
            "480p": 480
        }
        return mapping.get(normalized)

    def _computeTargetDimensions(self, original_w, original_h, target_h=None, target_short_side=None):
        if original_w <= 0 or original_h <= 0:
            return None, None

        if target_short_side:
            # Don't upscale: if target is larger than source, skip scaling
            if target_short_side >= min(original_w, original_h):
                return None, None
            scale_factor = target_short_side / min(original_w, original_h)
            target_w = math.ceil(original_w * scale_factor)
            target_h_out = math.ceil(original_h * scale_factor)
        elif target_h:
            # Don't upscale: if target height is larger than source, skip scaling
            if target_h >= original_h:
                return None, None
            target_h_out = target_h
            target_w = math.ceil((original_w / original_h) * target_h_out)
        else:
            return None, None

        target_w = target_w if target_w % 2 == 0 else target_w + 1
        target_h_out = target_h_out if target_h_out % 2 == 0 else target_h_out + 1
        return target_w, target_h_out

    def _showTextDialog(self, title, text):
        dialog = QDialog(self)
        dialog.setWindowTitle(title)
        dialog.resize(720, 520)

        layout = QVBoxLayout(dialog)
        output_view = QPlainTextEdit(dialog)
        output_view.setReadOnly(True)
        output_view.setLineWrapMode(QPlainTextEdit.LineWrapMode.NoWrap)
        output_view.setPlainText(text)
        layout.addWidget(output_view)

        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Close, parent=dialog)
        buttons.rejected.connect(dialog.reject)
        buttons.accepted.connect(dialog.accept)
        layout.addWidget(buttons)

        dialog.exec()

    def showFfmpegEncoders(self):
        VideoProcessor.setup_ffmpeg_path()
        try:
            result = subprocess.run(
                ["ffmpeg", "-hide_banner", "-encoders"],
                capture_output=True,
                text=True,
                env=VideoProcessor.get_ffmpeg_env()
            )
        except Exception as e:
            InfoBar.error(
                title='Error',
                content=f"Failed to run ffmpeg: {e}",
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=4000,
                parent=self
            )
            return

        output = ""
        if result.stdout:
            output += result.stdout.strip()
        if result.stderr:
            if output:
                output += "\n\n"
            output += result.stderr.strip()

        if not output:
            output = "No output from ffmpeg -encoders."

        title = "FFmpeg Encoders"
        if result.returncode != 0:
            title = "FFmpeg Encoders (Error)"

        self._showTextDialog(title, output)

    def convertVideoFromButton(self):
        if self.file_path:
            self.convertVideo(self.file_path)
        else:
            self.etaLabel.setText("No file selected!")
            InfoBar.warning(
                title='Warning',
                content="No file selected!",
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=2000,
                parent=self
            )

    def dragEnterEvent(self, event: QDragEnterEvent):
        if event.mimeData().hasUrls():
            event.acceptProposedAction()

    def dropEvent(self, event: QDropEvent):
        urls = event.mimeData().urls()
        if urls:
            file_path = urls[0].toLocalFile()
            self.loadVideo(file_path)

    def openFileDialog(self):
        fileName, _ = QFileDialog.getOpenFileName(
            self, "Choose a video file", "",
            "Video Files (*.mp4 *.avi *.mov *.mkv *.flv *.wmv *.webm);;All Files (*)"
        )
        if fileName:
            self.loadVideo(fileName)

    def _actualUpdatePreview(self):
        if self.file_path and self.probed_data.get('duration', 0) > 0:
            self.updatePreview(self.lastSliderValueForPreview)

    def loadVideo(self, filePath):
        if not filePath.lower().endswith(('.mp4', '.avi', '.mov', '.mkv', '.flv', '.wmv', '.webm')):
            self.label.setText("Unsupported file format.")
            return
            
        # Stop any pending preview updates from previous video
        self.previewUpdateTimer.stop()
        self.stopPreviewPlayback()
        self.videoPreview.setPlayEnabled(False)
        
        self.file_path = filePath
        self.label.setText(f'{os.path.basename(filePath)}')
        
        try:
            self.probed_data = self.video_processor.probe_video(self.file_path)
            
            self.duration_for_slider = self.probed_data['duration'] * 10

            if self.probed_data.get('width') and self.probed_data.get('height'):
                self.videoPreview.setContentAspectRatio(
                    int(self.probed_data['width']),
                    int(self.probed_data['height'])
                )
            
            # Block signals to prevent redundant preview triggers during setup
            self.startTimeSlider.blockSignals(True)
            self.endTimeSlider.blockSignals(True)
            
            self.startTimeSlider.setMaximum(int(self.duration_for_slider))
            self.endTimeSlider.setMaximum(int(self.duration_for_slider))
            self.startTimeSlider.setValue(0)
            self.endTimeSlider.setValue(int(self.duration_for_slider))
            
            self.startTimeSlider.blockSignals(False)
            self.endTimeSlider.blockSignals(False)
            
            # Explicitly reset state and force update
            self.lastSliderValueForPreview = 0.0
            self.videoPreview.setText("Loading Preview...")
            self.updatePreview(0.0)
            
        except Exception as e:
            self.label.setText(f"Error loading video: {e}")
            self.videoPreview.setText("Error loading preview")
            self.videoPreview.setPlayEnabled(False)

    def updateStartTime(self):
        self.stopPreviewPlayback()
        start_val = self.startTimeSlider.value()
        start_time_sec = start_val / 10.0
        self.startLabel.setText(f'{start_time_sec:.1f}s')
        
        if self.endTimeSlider.value() < start_val:
            self.endTimeSlider.blockSignals(True)
            self.endTimeSlider.setValue(start_val)
            self.endTimeSlider.blockSignals(False)
            self.endLabel.setText(f'{start_time_sec:.1f}s')
            
        self.lastSliderValueForPreview = start_time_sec
        self.previewUpdateTimer.start(self.previewDebounceTime)

    def updateEndTime(self):
        self.stopPreviewPlayback()
        end_val = self.endTimeSlider.value()
        end_time_sec = end_val / 10.0
        self.endLabel.setText(f'{end_time_sec:.1f}s')
        
        if self.startTimeSlider.value() > end_val:
            self.startTimeSlider.blockSignals(True)
            self.startTimeSlider.setValue(end_val)
            self.startTimeSlider.blockSignals(False)
            self.startLabel.setText(f'{end_time_sec:.1f}s')
            
        self.lastSliderValueForPreview = end_time_sec
        self.previewUpdateTimer.start(self.previewDebounceTime)

    def updatePreview(self, time_sec):
        # Retire existing thread if running
        if self.preview_thread and self.preview_thread.isRunning():
            old_thread = self.preview_thread
            try:
                old_thread.preview_ready.disconnect(self.onPreviewReady)
            except Exception:
                pass
            old_thread.stop()
            old_thread.finished.connect(lambda: self.active_preview_threads.discard(old_thread))
            old_thread.finished.connect(old_thread.deleteLater)
            # We keep it in a set to prevent garbage collection until it actually finishes
            self.active_preview_threads.add(old_thread)
        
        self.preview_thread = PreviewThread(self.file_path, time_sec)
        self.preview_thread.preview_ready.connect(self.onPreviewReady)
        self.preview_thread.start()


    def onPreviewReady(self, temp_path):
        if temp_path and os.path.exists(temp_path):
            pixmap = QPixmap(temp_path)
            if not pixmap.isNull():
                target_size = self.videoPreview.imageSize()
                if target_size.width() > 0 and target_size.height() > 0:
                    scaled = pixmap.scaled(target_size, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)
                else:
                    scaled = pixmap
                self.videoPreview.setPixmap(scaled)
                if self.previewPlayer is not None and self.videoPreview.hasVideoOutput():
                    self.videoPreview.setPlayEnabled(True)
                else:
                    self.videoPreview.setPlayEnabled(False)
                try:
                    os.remove(temp_path)
                except Exception:
                    pass
            else:
                self.videoPreview.setText("Preview Error")
                self.videoPreview.setPlayEnabled(False)

    def playPreviewSegment(self):
        if not self.file_path:
            InfoBar.warning(
                title='Warning',
                content="No file selected!",
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=2000,
                parent=self
            )
            return
        if self.previewPlayer is None or not self.videoPreview.hasVideoOutput():
            InfoBar.warning(
                title='Warning',
                content="Preview playback is not available on this system.",
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=3000,
                parent=self
            )
            return

        start_time = self.startTimeSlider.value() / 10.0
        end_time = self.endTimeSlider.value() / 10.0
        if end_time <= start_time:
            InfoBar.warning(
                title='Warning',
                content="Invalid trim range for preview.",
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=2000,
                parent=self
            )
            return

        start_ms = int(start_time * 1000)
        self.previewStartMs = start_ms
        self.previewEndMs = int(end_time * 1000)

        self.previewPlayer.stop()
        self.previewPlayer.setSource(QUrl.fromLocalFile(self.file_path))
        self.previewPlayer.setPosition(start_ms)
        output_type, output_target = self.videoPreview.videoOutputTarget()
        try:
            if output_type == "sink":
                if hasattr(self.previewPlayer, "setVideoSink"):
                    self.previewPlayer.setVideoSink(output_target)
                else:
                    self.previewPlayer.setVideoOutput(output_target)
            elif output_type == "widget":
                self.previewPlayer.setVideoOutput(output_target)
            else:
                raise RuntimeError("No compatible video output")
        except Exception:
            InfoBar.warning(
                title='Warning',
                content="No compatible video output for preview.",
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=3000,
                parent=self
            )
            return

        self.videoPreview.showVideo()
        self.videoPreview.setPlaying(True)
        self.previewPendingSeek = True
        if self.previewPlayer.mediaStatus() in (
            QMediaPlayer.MediaStatus.LoadedMedia,
            QMediaPlayer.MediaStatus.BufferedMedia,
        ):
            self._startPreviewPlayback()

    def stopPreviewPlayback(self):
        if self.previewPlayer is not None:
            try:
                if self.previewPlayer.playbackState() != QMediaPlayer.PlaybackState.StoppedState:
                    self.previewPlayer.stop()
            except Exception:
                self.previewPlayer.stop()
        self.previewEndMs = None
        self.previewStartMs = None
        self.previewPendingSeek = False
        self.videoPreview.setPlaying(False)
        self.videoPreview.showImage()

    def _startPreviewPlayback(self):
        if self.previewPlayer is None or self.previewStartMs is None:
            return
        self.previewPlayer.setPosition(self.previewStartMs)
        self.previewPlayer.play()
        self.previewPendingSeek = False

    def _onPreviewPositionChanged(self, position: int):
        if self.previewEndMs is not None and position >= self.previewEndMs:
            self.stopPreviewPlayback()

    def _onPreviewMediaStatusChanged(self, status):
        if self.previewPendingSeek and status in (
            QMediaPlayer.MediaStatus.LoadedMedia,
            QMediaPlayer.MediaStatus.BufferedMedia,
        ):
            self._startPreviewPlayback()

    def _onPreviewPlaybackError(self, error, error_string=None):
        # Show a brief, cross-platform friendly message for missing codecs/backends
        message = "Preview playback failed."
        if error_string:
            message = f"Preview playback failed: {error_string}"
        InfoBar.warning(
            title='Preview Error',
            content=message,
            orient=Qt.Orientation.Horizontal,
            isClosable=True,
            position=InfoBarPosition.TOP,
            duration=4000,
            parent=self
        )
        self.stopPreviewPlayback()

    def _onPreviewPlaybackStateChanged(self, state):
        is_playing = state == QMediaPlayer.PlaybackState.PlayingState
        self.videoPreview.setPlaying(is_playing)
        if not is_playing:
            self.videoPreview.showImage()

    def convertVideo(self, filePath):
        # Get settings
        use_advanced = self.advancedModeCheck.isChecked()
        target_h = None
        target_short_side = None

        if use_advanced:
            target_size_text = self.advancedTargetSizeInput.text().strip()
            try:
                target_size = float(target_size_text)
            except ValueError:
                self.etaLabel.setText("Invalid target size")
                InfoBar.warning(
                    title='Warning',
                    content="Enter a valid target size in MB.",
                    orient=Qt.Orientation.Horizontal,
                    isClosable=True,
                    position=InfoBarPosition.TOP,
                    duration=2500,
                    parent=self
                )
                return

            if target_size <= 0:
                self.etaLabel.setText("Invalid target size")
                InfoBar.warning(
                    title='Warning',
                    content="Target size must be greater than 0 MB.",
                    orient=Qt.Orientation.Horizontal,
                    isClosable=True,
                    position=InfoBarPosition.TOP,
                    duration=2500,
                    parent=self
                )
                return

            target_short_side = self._resolutionChoiceToShortSide(
                self.advancedResolutionComboBox.currentText()
            )

            custom_encoder_text = self.advancedEncoderInput.text().strip()
            if custom_encoder_text in self.encoder_mapping:
                selected_encoder = self.encoder_mapping[custom_encoder_text]
            elif custom_encoder_text:
                selected_encoder = custom_encoder_text
            else:
                selected_encoder_label = self.encoderComboBox.currentText()
                selected_encoder = self.encoder_mapping.get(selected_encoder_label, 'libx264')
        else:
            quality = self.qualityComboBox.currentText()
            # Look up preset from QUALITY_PRESETS
            preset = None
            for p in QUALITY_PRESETS:
                if p['label'] == quality:
                    preset = p
                    break
            if preset:
                target_size = preset['size_mb']
                target_h = preset['target_h']
            else:
                # Fallback if label doesn't match
                target_size = 500
                target_h = None

            selected_encoder_label = self.encoderComboBox.currentText()
            selected_encoder = self.encoder_mapping.get(selected_encoder_label, 'libx264')

        start_time = self.startTimeSlider.value() / 10.0
        end_time = self.endTimeSlider.value() / 10.0
        clip_duration = end_time - start_time
        
        if clip_duration <= 0:
            self.etaLabel.setText("Invalid duration")
            return

        # Calculate bitrate
        remove_audio = self.removeAudioCheck.isChecked()
        target_bitrate = self.video_processor.calculate_bitrate(target_size, clip_duration, remove_audio=remove_audio)
        
        # Cap bitrate if needed
        original_bitrate = self.probed_data.get('bitrate', 0)
        if original_bitrate > 0 and target_bitrate > original_bitrate:
            target_bitrate = original_bitrate

        # Prepare output path
        downloads_path = str(pathlib.Path.home() / "Downloads")
        if not os.path.exists(downloads_path):
            os.makedirs(downloads_path, exist_ok=True)
            
        base_name = os.path.basename(filePath)
        name, _ = os.path.splitext(base_name)
        output_file = os.path.join(downloads_path, f"{name}-vidcord.mp4")

        # Prepare filters
        filters = []
        original_w = self.probed_data.get('width', 0)
        original_h = self.probed_data.get('height', 0)

        target_w, target_h_out = self._computeTargetDimensions(
            original_w, original_h, target_h=target_h, target_short_side=target_short_side
        )

        if target_w and target_h_out:
            filters.append(f"scale={target_w}:{target_h_out}")
        else:
            # Removed single quotes around trunc(...) as they can cause "Option not found" with some ffmpeg builds/shells
            filters.append("scale=trunc(iw/2)*2:trunc(ih/2)*2")

        # Build Command
        cmd = ["ffmpeg", "-hide_banner", "-y"]
        
        # VAAPI specific setup
        if selected_encoder.endswith('_vaapi'):
            vaapi_dev = self.video_processor.get_vaapi_device()
            if vaapi_dev:
                # Use typical VAAPI initialization: -init_hw_device vaapi=va:/dev/dri/renderD128 -filter_hw_device va
                cmd.extend(["-init_hw_device", f"vaapi=va:{vaapi_dev}", "-filter_hw_device", "va"])
                
                # Update filters for hardware path
                filters = [] # Clear software scalers
                filters.append("format=nv12,hwupload") # ensure data is uploaded to GPU
                
                if target_w and target_h_out:
                    # Use scale_vaapi instead of software scale
                    filters.append(f"scale_vaapi=w={target_w}:h={target_h_out}")
                else:
                    # Generic scaling if needed, otherwise just the format/upload
                    # Note: trunc logic in software scale is harder to replicate exactly in scale_vaapi directly without complex expr, 
                    # but scale_vaapi generally handles div2 automatically.
                    filters.append("scale_vaapi=w=iw:h=ih")
                    
            else:
                print("DEBUG: VAAPI selected but no device found. Falling back to CPU.")
                selected_encoder = 'libx264' # Safe fallback

        cmd.extend([
            "-ss", str(start_time),
            "-to", str(end_time),
            "-i", filePath,
            "-c:v", selected_encoder,
            "-b:v", f'{target_bitrate}k',
            "-vf", ",".join(filters),
        ])
        
        # Audio handling — must come BEFORE the output file
        if remove_audio:
            cmd.append("-an")
        else:
            cmd.extend(["-c:a", "aac", "-b:a", "128k"])

        cmd.append(output_file)

        # Start Thread
        self.convertButton.setEnabled(False)
        self.progressBar.setValue(0)
        self.etaLabel.setText("Starting...")
        
        # Log the command for debugging
        print(f"DEBUG: FFmpeg Command: {cmd}")

        self.thread = CompressionThread(cmd, clip_duration, output_file=output_file)
        self.thread.progress_updated.connect(self.updateProgress)
        self.thread.finished.connect(lambda success, msg, output_file=output_file: self.conversionFinished(success, msg, output_file))
        self.thread.start()

    def updateProgress(self, percent, eta, status):
        self.progressBar.setValue(percent)
        self.etaLabel.setText(f"{status} ETA: {eta}")

    def conversionFinished(self, success, message, output_file):
        self.convertButton.setEnabled(True)
        self.etaLabel.setText(message)
        if success:
            self.progressBar.setValue(100)
            InfoBar.success(
                title='Success',
                content=message,
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=2000,
                parent=self
            )
            self.showInFileExplorer(output_file)
        else:
            self.progressBar.setValue(0)
            InfoBar.error(
                title='Error',
                content=message,
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=2000,
                parent=self
            )

    def showInFileExplorer(self, filePath):
        abs_path = os.path.abspath(filePath)
        if sys.platform == 'win32':
            subprocess.run(['explorer', '/select,', abs_path])
        elif sys.platform == 'darwin':
            subprocess.run(['open', '-R', abs_path])
        elif sys.platform.startswith('linux'):
            subprocess.run(['xdg-open', os.path.dirname(abs_path)])

class MainWindow(FluentWindow):
    def __init__(self):
        super().__init__()
        self.initWindow()

        # Create sub interface
        self.homeInterface = VidCordInterface(self)
        self.homeInterface.setObjectName("homeInterface")

        # Add to navigation
        self.addSubInterface(self.homeInterface, FIF.VIDEO, 'Compressor')
        self.navigationInterface.hide()

    def initWindow(self):
        self.resize(600, 750)
        
        # Use resource_path for the window icon
        icon_path = resource_path('icon.ico')
        if not os.path.exists(icon_path):
            icon_path = resource_path('icon.png')
        self.setWindowIcon(QIcon(icon_path))

        self.setWindowTitle('vidcord')
        
        # Hide the default title bar elements
        self.titleBar.titleLabel.hide()
        self.titleBar.iconLabel.hide()

        # Fix title bar alignment
        self.titleBar.layout().setContentsMargins(0, 0, 0, 0)

        desktop = QApplication.primaryScreen().availableGeometry()
        w, h = desktop.width(), desktop.height()
        self.move(w//2 - self.width()//2, h//2 - self.height()//2)

    def event(self, event):
        if event.type() == QEvent.Type.FileOpen:
            file_path = event.file()
            if os.path.exists(file_path):
                self.homeInterface.loadVideo(file_path)
            return True
        return super().event(event)

class VidCordApp(QApplication):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.main_window = None

    def set_main_window(self, window):
        self.main_window = window

    def event(self, event):
        if event.type() == QEvent.Type.FileOpen:
            if self.main_window:
                self.main_window.event(event)
                return True
        return super().event(event)

if __name__ == '__main__':
    setup_logging()
    _log_startup_info()
    
    # Enable DPI scale
    QApplication.setHighDpiScaleFactorRoundingPolicy(Qt.HighDpiScaleFactorRoundingPolicy.PassThrough)


    setTheme(Theme.AUTO)

    app = VidCordApp(sys.argv)
    w = MainWindow()
    app.set_main_window(w)
    w.show()
    
    # Check for initial file argument
    if len(sys.argv) > 1:
        # On macOS with argv_emulation, the file might be in sys.argv
        # or it might come via FileOpen event.
        initial_file = sys.argv[1]
        if os.path.exists(initial_file) and not initial_file.startswith('-psn'):
            w.homeInterface.loadVideo(initial_file)

    sys.exit(app.exec())
