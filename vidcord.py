import sys
import os
import subprocess
import shlex
import ffmpeg
from PyQt6.QtWidgets import (QApplication, QWidget, QVBoxLayout, QHBoxLayout, QFileDialog)
from PyQt6.QtCore import Qt, QTimer, QThread, pyqtSignal, QSize
from PyQt6.QtGui import QDragEnterEvent, QDropEvent, QIcon, QPixmap, QPalette, QColor, QFont
import time
import platform
import math
import json
import pathlib
import requests
from packaging import version

# Added HyperlinkButton to imports
from qfluentwidgets import (FluentWindow, NavigationItemPosition, FluentIcon as FIF,
                            PrimaryPushButton, PushButton, ComboBox, CheckBox, Slider,
                            ProgressBar, TitleLabel, SubtitleLabel, BodyLabel, CaptionLabel,
                            InfoBar, InfoBarPosition, Theme, setTheme, CardWidget,
                            SimpleCardWidget, ImageLabel, ScrollArea, HyperlinkButton)

CURRENT_VERSION = "v5.0"

# --- LOGGING SETUP ---
log_path = os.path.join(os.path.expanduser('~'), 'vidcord_crash.log')
# Open the log file in append mode
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

print(f"Starting vidcord {CURRENT_VERSION}")

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
    
    bin_dir_found = False
    for bin_dir in possible_bin_dirs:
        if os.path.exists(bin_dir):
            os.environ["PATH"] += os.pathsep + bin_dir
            bin_dir_found = True
            # print(f"Found bin dir at: {bin_dir}") # Debug
            break
            
    if not bin_dir_found:
        print("WARNING: Could not find bin directory for ffmpeg/ffprobe")

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
            except:
                return {}
        return {}

    def save_settings(self, settings_dict):
        self.settings.update(settings_dict)
        try:
            with open(self.settings_file, 'w') as file:
                json.dump(self.settings, file)
        except Exception as e:
            print(f"Failed to save settings: {e}")

    def get(self, key, default=None):
        return self.settings.get(key, default)

class VideoProcessor:
    @staticmethod
    def get_system_gpus():
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
                # Windows
                cmd = 'wmic path win32_VideoController get name'
                output = subprocess.check_output(cmd, shell=True).decode('utf-8').lower()
                if 'nvidia' in output: gpus['nvidia'] = True
                if 'amd' in output or 'radeon' in output: gpus['amd'] = True
                if 'intel' in output: gpus['intel'] = True
                
            else:
                # Linux
                try:
                    cmd = ['lspci']
                    output = subprocess.check_output(cmd).decode('utf-8').lower()
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
            return {'nvidia': True, 'amd': True, 'intel': True, 'apple': True}
            
        return gpus

    @staticmethod
    def get_available_encoders():
        try:
            encoders_output = subprocess.run(
                shlex.split('ffmpeg -hide_banner -encoders'),
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
            ).stdout
        except FileNotFoundError:
            return []

        gpus = VideoProcessor.get_system_gpus()
        
        # Base mapping
        encoder_labels = {
            'libx264': 'CPU (libx264)',
        }
        
        # Add GPU encoders if hardware is detected
        if gpus['nvidia']:
            encoder_labels['h264_nvenc'] = 'NVIDIA (h264_nvenc)'
        if gpus['amd']:
            encoder_labels['h264_amf'] = 'AMD (h264_amf)'
        if gpus['apple']:
            encoder_labels['h264_videotoolbox'] = 'Apple Silicon (h264_videotoolbox)'
        if gpus['intel']:
            encoder_labels['h264_qsv'] = 'Intel (h264_qsv)'

        available_encoders = []
        for encoder in encoder_labels.keys():
            if encoder == 'libx264' or encoder in encoders_output:
                available_encoders.append((encoder, encoder_labels[encoder]))
        return available_encoders

    @staticmethod
    def calculate_bitrate(target_size_mb, duration_sec, audio_bitrate=128, remove_audio=False):
        target_size_kb = target_size_mb * 1024 * 8
        if remove_audio:
            audio_bitrate_kb = 0
        else:
            audio_bitrate_kb = audio_bitrate * duration_sec
        
        video_bitrate = (target_size_kb - audio_bitrate_kb) / duration_sec
        return int(video_bitrate * 0.9) # Safety margin

    @staticmethod
    def probe_video(file_path):
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
        if platform.system() == 'Windows':
            appdata_path = os.getenv('APPDATA')
            vidcord_temp_dir = os.path.join(appdata_path, 'vidcord')
        else:
            vidcord_temp_dir = os.path.join(os.path.expanduser('~'), '.vidcord')
        
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
            creationflags = subprocess.CREATE_NO_WINDOW if platform.system() == 'Windows' else 0
            subprocess.run(ffmpeg_command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, creationflags=creationflags)
            return temp_image_path
        except Exception as e:
            print(f"Preview generation failed: {e}")
            return None

class CompressionThread(QThread):
    progress_updated = pyqtSignal(int, str, str) # progress, eta, status
    finished = pyqtSignal(bool, str) # success, message

    def __init__(self, cmd, clip_duration):
        super().__init__()
        self.cmd = cmd
        self.clip_duration = clip_duration
        self.is_running = True

    def run(self):
        creationflags = subprocess.CREATE_NO_WINDOW if platform.system() == 'Windows' else 0
        process = subprocess.Popen(self.cmd, stderr=subprocess.PIPE, text=True, universal_newlines=True, creationflags=creationflags)
        
        encoding_start_time = time.time()
        encoding_started_for_eta = False
        
        while process.poll() is None and self.is_running:
            line = process.stderr.readline()
            if line:
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
                    except:
                        pass
        
        if not self.is_running:
            process.terminate()
            return
        
        process.wait()
        if process.returncode == 0:
            self.finished.emit(True, "Conversion complete!")
        else:
            self.finished.emit(False, "Conversion failed.")

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

    def __init__(self, video_processor, file_path, time_sec):
        super().__init__()
        self.video_processor = video_processor
        self.file_path = file_path
        self.time_sec = time_sec
        self.is_running = True

    def run(self):
        if not self.is_running: return
        
        # We call the static method directly or via the instance provided
        # Since generate_preview is static, we can just call it.
        # However, we need to be careful about race conditions if we were writing to the same file.
        # The original code writes to 'preview_frame.jpg'. 
        # To avoid conflicts with rapid updates, we might want a unique name or just accept overwrite.
        # For now, let's stick to the original logic but run it here.
        
        try:
            # We use a unique filename per thread to avoid file locking issues if multiple threads run (though we plan to cancel old ones)
            # Actually, the original code uses a fixed name. Let's modify it slightly to be safe or just use the existing method.
            # The existing method: generate_preview(file_path, time_sec) returns a path.
            
            # To be safe against UI spam, we should probably check is_running after the heavy operation too.
            temp_path = self.video_processor.generate_preview(self.file_path, self.time_sec)
            
            if self.is_running and temp_path:
                self.preview_ready.emit(temp_path)
        except Exception as e:
            print(f"Preview thread failed: {e}")

    def stop(self):
        self.is_running = False
        # Do not wait() here, as it would block the UI thread if ffmpeg is running.
        # The thread will finish on its own.

class VidCordInterface(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent=parent)
        self.setObjectName("vidCordInterface")
        self.file_path = None
        self.settings_manager = SettingsManager()
        self.video_processor = VideoProcessor()
        
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
        settings_layout = QHBoxLayout()
        
        self.qualityComboBox = ComboBox(self)
        self.qualityComboBox.addItems(["10MB, 480p", "25MB, 480p", "50MB, 720p", "100MB, 1080p", "500MB, native res"])
        settings_layout.addWidget(BodyLabel("Target:", self))
        settings_layout.addWidget(self.qualityComboBox)
        
        self.encoderComboBox = ComboBox(self)
        available_encoders = self.video_processor.get_available_encoders()
        self.encoder_mapping = {label: encoder for encoder, label in available_encoders}
        for _, label in available_encoders:
            self.encoderComboBox.addItem(label)
        settings_layout.addWidget(BodyLabel("Encoder:", self))
        settings_layout.addWidget(self.encoderComboBox)
        
        self.main_layout.addLayout(settings_layout)

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
        self.videoPreview = ImageLabel(self)
        self.videoPreview.setFixedHeight(200)
        self.videoPreview.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.videoPreview.setBorderRadius(8, 8, 8, 8)
        self.videoPreview.setText("Preview")
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
        
        footer_layout.addStretch()
        footer_layout.addWidget(version_label)
        footer_layout.addWidget(self.github_link)
        footer_layout.addStretch()
        
        self.main_layout.addLayout(footer_layout)

        self.setLayout(self.main_layout)
        
        self.startTimeSlider.valueChanged.connect(self.updateStartTime)
        self.endTimeSlider.valueChanged.connect(self.updateEndTime)
        self.loadPreviousSelections()

        self.qualityComboBox.currentIndexChanged.connect(self.saveCurrentSelections)
        self.encoderComboBox.currentIndexChanged.connect(self.saveCurrentSelections)

    def checkForUpdates(self):
        # Simple threaded check to avoid blocking UI
        pass 

    def loadPreviousSelections(self):
        quality_index = self.settings_manager.get("quality_index", 0)
        encoder_index = self.settings_manager.get("encoder_index", 0)
        self.qualityComboBox.setCurrentIndex(quality_index)
        self.encoderComboBox.setCurrentIndex(encoder_index)

    def saveCurrentSelections(self, index=None):
        self.settings_manager.save_settings({
            "quality_index": self.qualityComboBox.currentIndex(),
            "encoder_index": self.encoderComboBox.currentIndex()
        })

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

    def loadVideo(self, filePath):
        if not filePath.lower().endswith(('.mp4', '.avi', '.mov', '.mkv', '.flv', '.wmv', '.webm')):
            self.label.setText("Unsupported file format.")
            return
            
        self.file_path = filePath
        self.label.setText(f'{os.path.basename(filePath)}')
        
        try:
            self.probed_data = self.video_processor.probe_video(self.file_path)
            
            self.duration_for_slider = self.probed_data['duration'] * 10
            self.startTimeSlider.setMaximum(int(self.duration_for_slider))
            self.endTimeSlider.setMaximum(int(self.duration_for_slider))
            self.startTimeSlider.setValue(0)
            self.endTimeSlider.setValue(int(self.duration_for_slider))
            
            self._actualUpdatePreview()
        except Exception as e:
            self.label.setText(f"Error loading video: {e}")
            self.videoPreview.setText("Error loading preview")

    def _actualUpdatePreview(self):
        if self.file_path and self.probed_data.get('duration', 0) > 0:
            self.updatePreview(self.lastSliderValueForPreview)

    def updateStartTime(self):
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
        # Cancel existing thread if running
        if self.preview_thread and self.preview_thread.isRunning():
            self.preview_thread.stop()
        
        self.preview_thread = PreviewThread(self.video_processor, self.file_path, time_sec)
        self.preview_thread.preview_ready.connect(self.onPreviewReady)
        self.preview_thread.start()

    def onPreviewReady(self, temp_path):
        if temp_path and os.path.exists(temp_path):
            pixmap = QPixmap(temp_path)
            if not pixmap.isNull():
                self.videoPreview.setPixmap(pixmap.scaled(self.videoPreview.size(), Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation))
                try:
                    os.remove(temp_path)
                except:
                    pass
            else:
                self.videoPreview.setText("Preview Error")

    def convertVideo(self, filePath):
        # Get settings
        quality = self.qualityComboBox.currentText()
        if "10MB" in quality: target_size = 10; target_h = 480
        elif "25MB" in quality: target_size = 25; target_h = 480
        elif "50MB" in quality: target_size = 50; target_h = 720
        elif "100MB" in quality: target_size = 100; target_h = 1080
        else: target_size = 500; target_h = None

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
        base_name = os.path.basename(filePath)
        name, _ = os.path.splitext(base_name)
        output_file = os.path.join(downloads_path, f"{name}-vidcord.mp4")

        # Prepare filters
        filters = []
        original_w = self.probed_data.get('width', 0)
        original_h = self.probed_data.get('height', 0)
        
        if target_h and original_h > 0:
            target_w = math.ceil((original_w / original_h) * target_h)
            target_w = target_w if target_w % 2 == 0 else target_w + 1
            target_h = target_h if target_h % 2 == 0 else target_h + 1
            filters.append(f"scale={target_w}:{target_h}")
        else:
            filters.append(f"scale='trunc(iw/2)*2':'trunc(ih/2)*2'")

        # Build Command
        selected_encoder_label = self.encoderComboBox.currentText()
        selected_encoder = self.encoder_mapping.get(selected_encoder_label, 'libx264')
        
        cmd = [
            "ffmpeg", "-hide_banner", "-y",
            "-ss", str(start_time),
            "-to", str(end_time),
            "-i", filePath,
            "-c:v", selected_encoder,
            "-b:v", f'{target_bitrate}k',
            "-vf", ",".join(filters),
            output_file
        ]
        
        if remove_audio:
            cmd.append("-an")
        else:
            cmd.extend(["-c:a", "aac", "-b:a", "128k"])

        # Start Thread
        self.convertButton.setEnabled(False)
        self.progressBar.setValue(0)
        self.etaLabel.setText("Starting...")
        
        self.thread = CompressionThread(cmd, clip_duration)
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

if __name__ == '__main__':
    # Enable DPI scale
    QApplication.setHighDpiScaleFactorRoundingPolicy(Qt.HighDpiScaleFactorRoundingPolicy.PassThrough)


    setTheme(Theme.AUTO)

    app = QApplication(sys.argv)
    w = MainWindow()
    w.show()
    
    # Check for initial file argument
    if len(sys.argv) > 1:
        initial_file = sys.argv[1]
        if os.path.exists(initial_file):
            w.homeInterface.loadVideo(initial_file)

    sys.exit(app.exec())