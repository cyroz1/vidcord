import sys
import os
import subprocess
import shlex
import ffmpeg
from PyQt5.QtWidgets import QApplication, QWidget, QVBoxLayout, QLabel, QFileDialog, QPushButton, QComboBox, QProgressBar, QSlider, QStyleFactory
from PyQt5.QtCore import Qt
from PyQt5.QtGui import QDragEnterEvent, QDropEvent, QIcon, QPixmap
import time
import platform
import math
import json
import pathlib

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

def get_video_duration(file_path):
    try:
        probe = ffmpeg.probe(file_path, v='error', show_entries='format=duration', format='default')
        duration_str = probe['format']['duration']
        if not duration_str or duration_str == 'N/A':
            raise ValueError("Duration is not available for this video.")
        try:
            duration = float(duration_str)
        except ValueError:
            raise ValueError("Invalid duration value.")
        return duration
    except ffmpeg.Error as e:
        print(f"Error probing video file: {e}")
        raise
    except ValueError as e:
        print(f"Error: {e}")
        raise
    except Exception as e:
        print(f"Unexpected error: {e}")
        raise

def calculate_bitrate(target_size_mb, duration_sec, audio_bitrate=128):
    target_size_kb = target_size_mb * 1024 * 8
    audio_bitrate_kb = audio_bitrate * duration_sec
    video_bitrate = (target_size_kb - audio_bitrate_kb) / duration_sec
    return int(video_bitrate * 0.85)

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

class vidcord(QWidget):
    def __init__(self, initial_file=None):
        super().__init__()
        self.file_path = initial_file
        self.settings = load_settings()
        self.initUI()

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
        self.linkLabel.setText('v4.5 | <a href="https://github.com/cyroz1/vidcord">GitHub</a> | <a href="https://cyroz.net">cyroz.net</a>')
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
        fileName, _ = QFileDialog.getOpenFileName(self, "Choose a video file to compress", "", "All Files (*);;Video Files (*.mp4 *.avi)", options=options)
        if fileName:
            self.loadVideo(fileName)

    def loadVideo(self, filePath):
        self.file_path = filePath
        self.label.setText(f'Selected file: {filePath}')
        try:
            self.duration = get_video_duration(filePath) * 10
            self.startTimeSlider.setMaximum(int(self.duration))
            self.endTimeSlider.setMaximum(int(self.duration))
            self.endTimeSlider.setValue(int(self.duration))
            self.updatePreview(0)
            self.updateStartTime()
            self.updateEndTime()
            self.activateWindow()
            self.raise_()
        except ValueError:
            self.label.setText("Could not retrieve video duration. Please select another file.")
            self.startTimeSlider.setEnabled(False)
            self.endTimeSlider.setEnabled(False)

    def updateStartTime(self):
        start_time = self.startTimeSlider.value() / 10.0
        self.startLabel.setText(f'Start: {start_time:.1f}s')
        self.updatePreview(start_time)

    def updateEndTime(self):
        end_time = self.endTimeSlider.value() / 10.0
        self.endLabel.setText(f'End: {end_time:.1f}s')
        self.updatePreview(end_time)

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
                "ffmpeg", "-y", "-ss", str(time_sec), "-i", self.file_path,
                "-frames:v", "1", "-q:v", "2", temp_image_path
            ]

            if platform.system() == 'Windows':
                creationflags = subprocess.CREATE_NO_WINDOW
            else:
                creationflags = 0

            subprocess.run(ffmpeg_command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, creationflags=creationflags)

            pixmap = QPixmap(temp_image_path)
            if not pixmap.isNull():
                self.videoPreview.setPixmap(pixmap.scaled(self.videoPreview.size(), Qt.KeepAspectRatio))
        except Exception as e:
            print(f"Error updating preview: {e}")
        finally:
            if os.path.exists(temp_image_path):
                os.remove(temp_image_path)

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

        start_time = self.startTimeSlider.value() / 10.0
        end_time = self.endTimeSlider.value() / 10.0

        duration = get_video_duration(filePath)
        if end_time > duration:
            end_time = duration

        clip_duration = end_time - start_time
        if clip_duration <= 0:
            raise ValueError("Clip duration must be greater than zero.")

        target_bitrate = calculate_bitrate(target_size_mb, clip_duration)

        selected_encoder_label = self.encoderComboBox.currentText()
        selected_encoder = self.encoder_mapping[selected_encoder_label]

        downloads_path = str(pathlib.Path.home() / "Downloads")
        base_name = os.path.basename(filePath)
        name, ext = os.path.splitext(base_name)
        output_file = os.path.join(downloads_path, f"{name}-vidcord.mp4")

        original_width, original_height = self.get_video_resolution(filePath)

        if target_height:
            target_width = math.ceil((original_width / original_height) * target_height)
            resolution_filter = f"scale={target_width}:{target_height}"
        else:
            resolution_filter = "scale=-1:-1"

        cmd = [
            "ffmpeg", "-i", filePath, "-ss", str(start_time), "-t", str(clip_duration),
            "-c:v", selected_encoder, "-b:v", f'{target_bitrate}k', "-c:a", 'aac', "-b:a", '128k',
            "-vf", resolution_filter, output_file, "-y"
        ]

        if platform.system() == 'Windows':
            creationflags = subprocess.CREATE_NO_WINDOW
        else:
            creationflags = 0

        process = subprocess.Popen(cmd, stderr=subprocess.PIPE, text=True, creationflags=creationflags)
        start_time = time.time()
        encoding_started = False
        while process.poll() is None:
            line = process.stderr.readline()
            if line:
                if "time=" in line:
                    if not encoding_started:
                        self.etaLabel.show()
                        encoding_started = True
                    time_str = line.split("time=")[1].split(" ")[0]
                    time_parts = time_str.split(":")
                    if all(part.replace('.', '', 1).isdigit() for part in time_parts):
                        current_time_sec = int(time_parts[0]) * 3600 + int(time_parts[1]) * 60 + float(time_parts[2])
                        percent = min((current_time_sec / clip_duration) * 100, 100)
                        elapsed_time = time.time() - start_time
                        eta = (elapsed_time / (current_time_sec / clip_duration)) - elapsed_time
                        self.progressBar.setValue(int(percent))
                        self.etaLabel.setText(self.format_time(eta))
            QApplication.processEvents()

        process.wait()
        self.progressBar.setValue(100)
        self.label.setText(f'Conversion complete: {output_file}')
        self.showInFileExplorer(output_file)

    def get_video_resolution(self, filePath):
        cmd = ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", filePath]
        result = subprocess.run(cmd, stdout=subprocess.PIPE, text=True)
        width, height = map(int, result.stdout.strip().split(","))
        return width, height

    def format_time(self, seconds):
        if seconds < 0:
            return "Calculating..."
        mins, secs = divmod(int(seconds), 60)
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
    os.environ['PATH'] = './_internal' + os.environ['PATH']
    initial_file = sys.argv[1] if len(sys.argv) > 1 else None
    app = QApplication(sys.argv)
    app.setWindowIcon(QIcon('_internal/icon.ico'))
    ex = vidcord(initial_file)
    ex.setWindowIcon(QIcon('_internal/icon.ico'))
    sys.exit(app.exec_())