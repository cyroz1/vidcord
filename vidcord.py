import sys
import os
import subprocess
import shlex
import ffmpeg
from PyQt5.QtWidgets import QApplication, QWidget, QVBoxLayout, QLabel, QFileDialog, QPushButton, QComboBox, QLineEdit, QProgressBar, QSlider, QHBoxLayout
from PyQt5.QtCore import Qt, QUrl, QTimer
from PyQt5.QtGui import QDragEnterEvent, QDropEvent, QIcon, QPixmap, QImage
import time
import cv2

def get_video_duration(file_path):
    try:
        probe = ffmpeg.probe(file_path, v='error', show_entries='format=duration', format='default')
        duration_str = probe['format']['duration']
        if duration_str == 'N/A':
            raise ValueError("Duration is not available for this video.")
        duration = float(duration_str)
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
    try:
        encoders_output = subprocess.run(
            shlex.split('ffmpeg -hide_banner -encoders'),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        ).stdout

        encoders = []
        if 'h264_nvenc' in encoders_output:
            encoders.append('h264_nvenc')
        if 'h264_amf' in encoders_output:
            encoders.append('h264_amf')
        if 'h264_videotoolbox' in encoders_output:
            encoders.append('h264_videotoolbox')
        if 'h264_qsv' in encoders_output:
            encoders.append('h264_qsv')
        if 'h264_vaapi' in encoders_output:
            encoders.append('h264_vaapi')
        encoders.append('libx264')
        return encoders
    except Exception as e:
        print(f"Error getting hardware encoders: {e}")
        return ['libx264']

class vidcord(QWidget):
    def __init__(self, initial_file=None):
        super().__init__()

        self.file_path = initial_file
        self.initUI()

    def initUI(self):
        self.setAcceptDrops(True)
        self.layout = QVBoxLayout()

        self.label = QLabel('Drag a video file or choose a file to compress', self)
        self.layout.addWidget(self.label)

        self.qualityComboBox = QComboBox(self)
        self.qualityComboBox.addItem("10MB, 480p")
        self.qualityComboBox.addItem("25MB, 480p")
        self.qualityComboBox.addItem("50MB, 720p")
        self.qualityComboBox.addItem("100MB, 1080p")
        self.qualityComboBox.addItem("500MB, native res")
        self.layout.addWidget(self.qualityComboBox)

        self.encoderComboBox = QComboBox(self)
        for encoder in get_available_encoders():
            self.encoderComboBox.addItem(encoder)
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

        self.openButton = QPushButton('Choose a file to compress', self)
        self.openButton.clicked.connect(self.openFileDialog)
        self.layout.addWidget(self.openButton)

        self.previewButton = QPushButton('Preview Selected Portion', self)
        self.previewButton.clicked.connect(self.previewSelectedPortion)
        self.layout.addWidget(self.previewButton)

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
        self.linkLabel.setText('<a href="https://github.com/cyroz1/vidcord">GitHub</a> | <a href="https://cyroz.net">cyroz.net</a>')
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

        cap = cv2.VideoCapture(self.file_path)
        cap.set(cv2.CAP_PROP_POS_MSEC, time_sec * 1000)
        ret, frame = cap.read()
        if ret:
            frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            h, w, ch = frame.shape
            bytes_per_line = ch * w
            qt_image = QImage(frame.data, w, h, bytes_per_line, QImage.Format_RGB888)
            pixmap = QPixmap.fromImage(qt_image)
            self.videoPreview.setPixmap(pixmap.scaled(self.videoPreview.size(), Qt.KeepAspectRatio))
        cap.release()

    def previewSelectedPortion(self):
        if not self.file_path:
            self.label.setText("No video file loaded.")
            return

        start_time = self.startTimeSlider.value() / 10.0
        end_time = self.endTimeSlider.value() / 10.0

        cap = cv2.VideoCapture(self.file_path)
        fps = cap.get(cv2.CAP_PROP_FPS)

        cap.set(cv2.CAP_PROP_POS_MSEC, start_time * 1000)

        window_name = 'Preview'
        cv2.namedWindow(window_name, cv2.WINDOW_NORMAL)
        cv2.resizeWindow(window_name, 640, 360)

        while cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                break

            current_time = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0

            if current_time >= end_time:
                self.updatePreview(end_time)
                break

            frame = cv2.resize(frame, (640, 360))
            cv2.imshow(window_name, frame)

            if cv2.waitKey(int(1000 / fps)) & 0xFF == ord('q'):
                break

        cap.release()
        cv2.destroyAllWindows()

    def convertVideo(self, filePath):
        try:
            quality = self.qualityComboBox.currentText()

            if "10MB, 480p" in quality:
                target_size_mb = 10
                resolution = "854x480"
            elif "25MB, 480p" in quality:
                target_size_mb = 25
                resolution = "854x480"
            elif "50MB, 720p" in quality:
                target_size_mb = 50
                resolution = "1280x720"
            elif "100MB, 1080p" in quality:
                target_size_mb = 100
                resolution = "1920x1080"
            else:
                target_size_mb = 500
                resolution = None

            start_time = self.startTimeSlider.value() / 10.0
            end_time = self.endTimeSlider.value() / 10.0

            duration = get_video_duration(filePath)
            if end_time > duration:
                end_time = duration

            clip_duration = end_time - start_time
            if clip_duration <= 0:
                raise ValueError("Clip duration must be greater than zero.")

            target_bitrate = calculate_bitrate(target_size_mb, clip_duration)

            selected_encoder = self.encoderComboBox.currentText()

            options = QFileDialog.Options()
            output_file, _ = QFileDialog.getSaveFileName(self, "Save Compressed Video", "", "MP4 Files (*.mp4);;All Files (*)", options=options)
            if not output_file:
                self.label.setText("Conversion cancelled")
                return

            cmd = [
                "ffmpeg", "-i", filePath, "-ss", str(start_time), "-t", str(clip_duration),
                "-c:v", selected_encoder, "-b:v", f'{target_bitrate}k', "-c:a", 'aac', "-b:a", '128k',
                "-vf", f'scale={resolution}' if resolution else "scale=-1:-1", output_file, "-y"
            ]

            process = subprocess.Popen(cmd, stderr=subprocess.PIPE, text=True, creationflags=subprocess.CREATE_NO_WINDOW)
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
            self.raise_()
            self.activateWindow()
        except Exception as e:
            self.label.setText(f"Error during conversion: {str(e)}")
            self.progressBar.setValue(0)
            self.etaLabel.setText("")

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