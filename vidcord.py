import sys
import os
import subprocess
import shlex
import ffmpeg
from PyQt5.QtWidgets import QApplication, QWidget, QVBoxLayout, QLabel, QFileDialog, QPushButton, QComboBox, QProgressBar, QSlider
from PyQt5.QtCore import Qt, QTimer
from PyQt5.QtGui import QDragEnterEvent, QDropEvent, QIcon, QPixmap
import time
import platform
import math
import json
import pathlib
import requests
from packaging import version

CURRENT_VERSION = "v4.8"

def get_settings_file_path():
    if platform.system() == 'Windows':
        return os.path.join(os.getenv('APPDATA'), 'vidcord_settings.json')
    else:
        return os.path.join(os.path.expanduser('~'), '.vidcord_settings.json')

SETTINGS_FILE = get_settings_file_path()

def load_settings():
    if os.path.exists(SETTINGS_FILE):
        with open(SETTINGS_FILE, 'r') as file:
            return json.load(file)
    return {}

def save_settings(settings):
    with open(SETTINGS_FILE, 'w') as file:
        json.dump(settings, file)

def calculate_bitrate(target_size_mb, duration_sec, audio_bitrate=128):
    target_size_kb = target_size_mb * 1024 * 8
    audio_bitrate_kb = audio_bitrate * duration_sec
    video_bitrate = (target_size_kb - audio_bitrate_kb) / duration_sec
    return int(video_bitrate * 0.9)

def get_available_encoders():
    encoders_output = subprocess.run(
        shlex.split('ffmpeg -hide_banner -encoders'),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
    ).stdout
    encoder_labels = {
        'libx264': 'CPU (libx264)',
        'h264_nvenc': 'NVIDIA (h264_nvenc)',
        'h264_amf': 'AMD (h264_amf)',
        'h264_videotoolbox': 'Apple Silicon (h264_videotoolbox)',
        'h264_qsv': 'Intel (h264_qsv)',
    }
    available_encoders = []
    for encoder in encoder_labels.keys():
        if encoder == 'libx264' or encoder in encoders_output:
            available_encoders.append((encoder, encoder_labels[encoder]))
    return available_encoders

def check_for_updates():
    try:
        response = requests.get("https://api.github.com/repos/cyroz1/vidcord/releases/latest", timeout=5)
        response.raise_for_status()
        latest_version = response.json().get("tag_name", "")
        normalized_latest_version = latest_version.lstrip("v")
        normalized_current_version = CURRENT_VERSION.lstrip("v")
        if normalized_latest_version and version.parse(normalized_latest_version) > version.parse(normalized_current_version):
            return f"A new version ({latest_version}) is available! Visit https://github.com/cyroz1/vidcord to update."
        return "You are using the latest version."
    except Exception as e:
        return f"Could not check for updates: {e}"

class vidcord(QWidget):
    def __init__(self, initial_file=None):
        super().__init__()
        self.file_path = initial_file
        self.settings = load_settings()
        self.probed_duration = 0.0
        self.probed_width = 0
        self.probed_height = 0
        self.probed_bitrate_kbps = 0
        self.duration_for_slider = 0
        self.previewUpdateTimer = QTimer(self)
        self.previewUpdateTimer.setSingleShot(True)
        self.previewUpdateTimer.timeout.connect(self._actualUpdatePreview)
        self.previewDebounceTime = 120
        self.lastSliderValueForPreview = 0.0
        self.initUI()
        self.checkForUpdates()

    def initUI(self):
        self.setAcceptDrops(True)
        self.layout = QVBoxLayout()
        self.label = QLabel('Drag a video file or choose a file to compress', self)
        self.layout.addWidget(self.label)
        self.openButton = QPushButton('Choose a file to compress', self)
        self.openButton.clicked.connect(self.openFileDialog)
        self.layout.addWidget(self.openButton)
        self.qualityComboBox = QComboBox(self)
        self.qualityComboBox.addItem("10MB, 480p")
        self.qualityComboBox.addItem("25MB, 480p")
        self.qualityComboBox.addItem("50MB, 720p")
        self.qualityComboBox.addItem("100MB, 1080p")
        self.qualityComboBox.addItem("500MB, native res")
        self.layout.addWidget(self.qualityComboBox)
        self.encoderComboBox = QComboBox(self)
        available_encoders = get_available_encoders()
        self.encoder_mapping = {label: encoder for encoder, label in available_encoders}
        for _, label in available_encoders:
            self.encoderComboBox.addItem(label)
        if available_encoders:
            self.encoderComboBox.setCurrentIndex(0)
        self.layout.addWidget(self.encoderComboBox)
        self.startTimeSlider = QSlider(Qt.Horizontal, self)
        self.startTimeSlider.setMinimum(0)
        self.startTimeSlider.setMaximum(1000)
        self.startTimeSlider.setValue(0)
        self.layout.addWidget(self.startTimeSlider)
        self.endTimeSlider = QSlider(Qt.Horizontal, self)
        self.endTimeSlider.setMinimum(0)
        self.endTimeSlider.setMaximum(1000)
        self.endTimeSlider.setValue(1000)
        self.layout.addWidget(self.endTimeSlider)
        self.startLabel = QLabel('Start: 0.0s', self)
        self.endLabel = QLabel('End: 0.0s', self)
        self.layout.addWidget(self.startLabel)
        self.layout.addWidget(self.endLabel)
        self.videoPreview = QLabel(self)
        self.videoPreview.setFixedHeight(200)
        self.layout.addWidget(self.videoPreview)
        self.convertButton = QPushButton('Compress', self)
        self.convertButton.clicked.connect(self.convertVideoFromButton)
        self.layout.addWidget(self.convertButton)
        self.progressLayout = QVBoxLayout()
        self.progressBar = QProgressBar(self)
        self.progressBar.setRange(0, 100)
        self.progressLayout.addWidget(self.progressBar)
        self.etaLabel = QLabel(self)
        self.progressLayout.addWidget(self.etaLabel)
        self.layout.addLayout(self.progressLayout)
        self.linkLabel = QLabel(self)
        self.linkLabel.setText(f'{CURRENT_VERSION} | <a href="https://github.com/cyroz1/vidcord">GitHub</a> | <a href="https://cyroz.net">cyroz.net</a>')
        self.linkLabel.setOpenExternalLinks(True)
        self.layout.addWidget(self.linkLabel)
        self.setLayout(self.layout)
        self.setWindowTitle('vidcord')
        self.setWindowIcon(QIcon('_internal/icon.ico'))
        self.show()
        if self.file_path:
            self.loadVideo(self.file_path)
        self.startTimeSlider.valueChanged.connect(self.updateStartTime)
        self.endTimeSlider.valueChanged.connect(self.updateEndTime)
        self.loadPreviousSelections()
        self.activateWindow()
        self.raise_()

    def checkForUpdates(self):
        update_message = check_for_updates()
        self.label.setText(update_message)
        print(update_message)

    def loadPreviousSelections(self):
        quality_index = self.settings.get("quality_index", 0)
        encoder_index = self.settings.get("encoder_index", 0)
        self.qualityComboBox.setCurrentIndex(quality_index)
        self.encoderComboBox.setCurrentIndex(encoder_index)

    def saveCurrentSelections(self):
        self.settings["quality_index"] = self.qualityComboBox.currentIndex()
        self.settings["encoder_index"] = self.encoderComboBox.currentIndex()
        save_settings(self.settings)

    def closeEvent(self, event):
        self.saveCurrentSelections()
        event.accept()

    def convertVideoFromButton(self):
        if self.file_path:
            self.convertVideo(self.file_path)
        else:
            self.label.setText("No file selected for conversion")

    def dragEnterEvent(self, event: QDragEnterEvent):
        if event.mimeData().hasUrls():
            event.acceptProposedAction()

    def dropEvent(self, event: QDropEvent):
        urls = event.mimeData().urls()
        if urls:
            file_path = urls[0].toLocalFile()
            self.loadVideo(file_path)

    def openFileDialog(self):
        options = QFileDialog.Options()
        fileName, _ = QFileDialog.getOpenFileName(
            self,
            "Choose a video file to compress",
            "",
            "Video Files (*.mp4 *.avi *.mov *.mkv *.flv *.wmv *.webm);;All Files (*)",
            options=options
        )
        if fileName:
            self.loadVideo(fileName)

    def _get_video_resolution_fallback(self, filePath):
        try:
            cmd = ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", filePath]
            result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True)
            output = result.stdout.strip().rstrip(",")
            if not output:
                raise ValueError("ffprobe returned empty resolution.")
            width, height = map(int, output.split(","))
            return width, height
        except Exception as e:
            print(f"Resolution fallback error: {e}")
            return 0,0

    def loadVideo(self, filePath):
        if not filePath.lower().endswith(('.mp4', '.avi', '.mov', '.mkv', '.flv', '.wmv', '.webm')):
            self.label.setText("Unsupported file format. Please select a valid video file.")
            return
        self.file_path = filePath
        self.label.setText(f'Selected file: {os.path.basename(filePath)}')
        try:
            probe_data = ffmpeg.probe(self.file_path)
            format_info = probe_data.get('format', {})
            duration_str = format_info.get('duration')
            if duration_str is None:
                raise ValueError("Duration not found in video metadata.")
            self.probed_duration = float(duration_str)
            video_stream = next((stream for stream in probe_data.get('streams', []) if stream.get('codec_type') == 'video'), None)
            if not video_stream:
                raise ValueError("No video stream found.")
            self.probed_width = int(video_stream.get('width', 0))
            self.probed_height = int(video_stream.get('height', 0))
            if video_stream.get('bit_rate') and video_stream['bit_rate'] != 'N/A':
                self.probed_bitrate_kbps = int(video_stream['bit_rate']) // 1000
            elif format_info.get('bit_rate') and format_info['bit_rate'] != 'N/A':
                self.probed_bitrate_kbps = int(format_info['bit_rate']) // 1000
            else:
                self.probed_bitrate_kbps = 0
                print("Warning: Could not determine original video bitrate from probe.")
            if self.probed_width == 0 or self.probed_height == 0:
                self.probed_width, self.probed_height = self._get_video_resolution_fallback(self.file_path)
                if self.probed_width == 0 or self.probed_height == 0:
                    raise ValueError("Could not determine video resolution.")
            self.duration_for_slider = self.probed_duration * 10
            self.startTimeSlider.setMaximum(int(self.duration_for_slider))
            self.endTimeSlider.setMaximum(int(self.duration_for_slider))
            self.startTimeSlider.setValue(0)
            self.endTimeSlider.setValue(int(self.duration_for_slider))
            self.startTimeSlider.setEnabled(True)
            self.endTimeSlider.setEnabled(True)
            self.updateStartTime()
            self.updateEndTime()
            if self.probed_duration > 0 :
                 self._actualUpdatePreview()
            self.showNormal()
            self.activateWindow()
            self.raise_()
        except Exception as e:
            self.label.setText(f"Error loading video: {e}")
            self.startTimeSlider.setEnabled(False)
            self.endTimeSlider.setEnabled(False)
            self.probed_duration = 0.0
            self.probed_width = 0
            self.probed_height = 0
            self.probed_bitrate_kbps = 0
            self.videoPreview.clear()
            return

    def _actualUpdatePreview(self):
        if self.file_path and self.probed_duration > 0:
            self.updatePreview(self.lastSliderValueForPreview)

    def updateStartTime(self):
        start_val = self.startTimeSlider.value()
        start_time_sec = start_val / 10.0
        self.startLabel.setText(f'Start: {start_time_sec:.1f}s')
        if self.endTimeSlider.value() < start_val:
            self.endTimeSlider.blockSignals(True)
            self.endTimeSlider.setValue(start_val)
            self.endTimeSlider.blockSignals(False)
            self.endLabel.setText(f'End: {start_time_sec:.1f}s')
        self.lastSliderValueForPreview = start_time_sec
        self.previewUpdateTimer.start(self.previewDebounceTime)

    def updateEndTime(self):
        end_val = self.endTimeSlider.value()
        end_time_sec = end_val / 10.0
        self.endLabel.setText(f'End: {end_time_sec:.1f}s')
        if self.startTimeSlider.value() > end_val:
            self.startTimeSlider.blockSignals(True)
            self.startTimeSlider.setValue(end_val)
            self.startTimeSlider.blockSignals(False)
            self.startLabel.setText(f'Start: {end_time_sec:.1f}s')
        self.lastSliderValueForPreview = end_time_sec
        self.previewUpdateTimer.start(self.previewDebounceTime)

    def updatePreview(self, time_sec):
        if not self.file_path:
            return
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
                "-i", self.file_path,
                "-an",
                "-sn",
                "-frames:v", "1",
                "-q:v", "4",
                "-vf", "scale=320:-1:flags=fast_bilinear",
                temp_image_path
            ]
            creationflags = subprocess.CREATE_NO_WINDOW if platform.system() == 'Windows' else 0
            subprocess.run(ffmpeg_command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, creationflags=creationflags)
            pixmap = QPixmap(temp_image_path)
            if not pixmap.isNull():
                self.videoPreview.setPixmap(pixmap.scaled(self.videoPreview.size(), Qt.KeepAspectRatio, Qt.SmoothTransformation))
            else:
                self.videoPreview.clear()
        except Exception as e:
            print(f"Error updating preview: {e}")
            self.videoPreview.clear()
        finally:
            if os.path.exists(temp_image_path):
                try:
                    os.remove(temp_image_path)
                except Exception as e:
                    print(f"Error removing temp preview file: {e}")

    def convertVideo(self, filePath):
        quality = self.qualityComboBox.currentText()
        if "10MB, 480p" in quality:
            target_size_mb = 10
            target_height = 480
        elif "25MB, 480p" in quality:
            target_size_mb = 25
            target_height = 480
        elif "50MB, 720p" in quality:
            target_size_mb = 50
            target_height = 720
        elif "100MB, 1080p" in quality:
            target_size_mb = 100
            target_height = 1080
        else:
            target_size_mb = 500
            target_height = None
        start_time_sec = self.startTimeSlider.value() / 10.0
        end_time_sec = self.endTimeSlider.value() / 10.0
        if self.probed_duration == 0:
            self.label.setText("Error: Video duration not loaded.")
            return
        if end_time_sec > self.probed_duration:
            end_time_sec = self.probed_duration
        if start_time_sec >= end_time_sec:
            self.label.setText("Error: Start time must be less than end time.")
            self.progressBar.setValue(0)
            self.etaLabel.setText("")
            return
        clip_duration = end_time_sec - start_time_sec
        if clip_duration <= 0:
            self.label.setText("Error: Clip duration must be positive.")
            self.progressBar.setValue(0)
            self.etaLabel.setText("")
            return
        target_bitrate_k = calculate_bitrate(target_size_mb, clip_duration)
        if self.probed_bitrate_kbps > 0 and target_bitrate_k > self.probed_bitrate_kbps:
            target_bitrate_k = self.probed_bitrate_kbps
        selected_encoder_label = self.encoderComboBox.currentText()
        selected_encoder = self.encoder_mapping[selected_encoder_label]
        downloads_path = str(pathlib.Path.home() / "Downloads")
        base_name = os.path.basename(filePath)
        name, ext = os.path.splitext(base_name)
        output_file = os.path.join(downloads_path, f"{name}-vidcord.mp4")
        original_width, original_height = self.probed_width, self.probed_height
        if original_width == 0 or original_height == 0:
            self.label.setText("Error: Could not determine original video resolution.")
            return
        resolution_filter_parts = []
        if target_height:
            if original_height == 0:
                self.label.setText("Error: Original video height is zero, cannot calculate target width.")
                return
            target_width = math.ceil((original_width / original_height) * target_height)
            target_width = target_width if target_width % 2 == 0 else target_width + 1
            target_height_actual = target_height if target_height % 2 == 0 else target_height + 1
            resolution_filter_parts.append(f"scale={target_width}:{target_height_actual}")
        else:
            resolution_filter_parts.append(f"scale='trunc(iw/2)*2':'trunc(ih/2)*2'")
        cmd = [
            "ffmpeg", "-hide_banner", "-i", filePath,
            "-ss", str(start_time_sec), "-to", str(end_time_sec),
            "-c:v", selected_encoder, "-b:v", f'{target_bitrate_k}k',
            "-c:a", 'aac', "-b:a", '128k',
            "-vf", ",".join(resolution_filter_parts),
            output_file, "-y"
        ]
        self.label.setText(f"Compressing... {os.path.basename(output_file)}")
        self.progressBar.setValue(0)
        self.etaLabel.setText("Starting...")
        creationflags = subprocess.CREATE_NO_WINDOW if platform.system() == 'Windows' else 0
        process = subprocess.Popen(cmd, stderr=subprocess.PIPE, text=True, universal_newlines=True, creationflags=creationflags)
        encoding_start_time = time.time()
        encoding_started_for_eta = False
        while process.poll() is None:
            line = process.stderr.readline()
            if line:
                print(line.strip())
                if "time=" in line:
                    if not encoding_started_for_eta:
                        self.etaLabel.show()
                        encoding_started_for_eta = True
                    try:
                        time_str = line.split("time=")[1].split(" ")[0]
                        if time_str != "N/A":
                            h, m, s = map(float, time_str.split(':'))
                            current_time_sec_processed = h * 3600 + m * 60 + s
                            if clip_duration > 0:
                                percent = min((current_time_sec_processed / clip_duration) * 100, 100)
                                self.progressBar.setValue(int(percent))
                                elapsed_time = time.time() - encoding_start_time
                                if current_time_sec_processed > 0:
                                    eta = (elapsed_time / (current_time_sec_processed / clip_duration)) - elapsed_time
                                    self.etaLabel.setText(self.format_time(eta))
                                else:
                                    self.etaLabel.setText("Calculating ETA...")
                    except ValueError:
                        print(f"Could not parse time from ffmpeg: {line.strip()}")
                        self.etaLabel.setText("Processing...")
            QApplication.processEvents()
        process.wait()
        if process.returncode == 0:
            self.progressBar.setValue(100)
            self.label.setText(f'Conversion complete: {output_file}')
            self.etaLabel.setText("Done!")
            self.showInFileExplorer(output_file)
        else:
            self.progressBar.setValue(0)
            self.label.setText(f'Conversion failed. Check console for errors.')
            self.etaLabel.setText("Failed")

    def format_time(self, seconds):
        if seconds < 0:
            return "Calculating..."
        mins, secs = divmod(int(seconds), 60)
        if mins > 60:
            hours, mins = divmod(mins, 60)
            return f"{hours}h {mins}m {secs}s"
        return f"{mins}m {secs}s"

    def showInFileExplorer(self, filePath):
        abs_path = os.path.abspath(filePath)
        if sys.platform == 'win32':
            subprocess.run(['explorer', '/select,', abs_path])
        elif sys.platform == 'darwin':
            subprocess.run(['open', '-R', abs_path])
        elif sys.platform.startswith('linux'):
            subprocess.run(['xdg-open', os.path.dirname(abs_path)])

if __name__ == '__main__':
    if platform.system() == 'Windows':
        internal_path = os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), '_internal')
    else:
        if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS'):
             internal_path = os.path.join(sys._MEIPASS, '_internal')
        else:
             internal_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '_internal')
    if os.path.exists(internal_path):
        os.environ['PATH'] = internal_path + os.pathsep + os.environ['PATH']
    else:
        print(f"Warning: _internal directory not found at {internal_path}. FFmpeg/FFprobe might not be found if not in system PATH.")
    initial_file = sys.argv[1] if len(sys.argv) > 1 else None
    app = QApplication(sys.argv)
    icon_path = os.path.join(internal_path, 'icon.ico')
    if not os.path.exists(icon_path) and hasattr(sys, '_MEIPASS'):
        icon_path = os.path.join(sys._MEIPASS, 'icon.ico')
    if os.path.exists(icon_path):
        app.setWindowIcon(QIcon(icon_path))
        ex = vidcord(initial_file)
        ex.setWindowIcon(QIcon(icon_path))
    else:
        print(f"Warning: Icon file not found at {icon_path} or default bundle location.")
        ex = vidcord(initial_file)
    sys.exit(app.exec_())