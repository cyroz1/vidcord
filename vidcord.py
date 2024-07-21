import sys
import subprocess
import shlex
import os
from PyQt5.QtWidgets import QApplication, QWidget, QVBoxLayout, QLabel, QFileDialog, QPushButton, QComboBox
from PyQt5.QtCore import Qt, QUrl
from PyQt5.QtGui import QDragEnterEvent, QDropEvent, QClipboard

def get_video_duration(file_path):
    command = f'ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "{file_path}"'
    result = subprocess.run(shlex.split(command), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return float(result.stdout.strip())

def calculate_bitrate(target_size_mb, duration_sec):
    target_size_kb = target_size_mb * 1024
    target_size_kb *= 8
    bitrate = target_size_kb / duration_sec
    return int(bitrate)

def get_hardware_encoder():
    encoders = subprocess.run(['ffmpeg', '-hide_banner', '-encoders'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    encoder_list = encoders.stdout
    
    if 'h264_nvenc' in encoder_list:
        return 'h264_nvenc'
    elif 'h264_amf' in encoder_list:
        return 'h264_amf'
    elif 'h264_videotoolbox' in encoder_list:
        return 'h264_videotoolbox'
    else:
        return 'libx264'

class vidcord(QWidget):
    def __init__(self, file_path=None):
        super().__init__()

        self.file_path = file_path
        self.encoder = get_hardware_encoder()
        self.initUI()
        
    def initUI(self):
        self.setAcceptDrops(True)
        self.layout = QVBoxLayout()
        
        self.label = QLabel('Drag a video file here to convert or click to open', self)
        self.layout.addWidget(self.label)
        
        self.qualityComboBox = QComboBox(self)
        self.qualityComboBox.addItem("Low (25MB, 480p)")
        self.qualityComboBox.addItem("High (50MB, 720p)")
        self.layout.addWidget(self.qualityComboBox)
        
        self.openButton = QPushButton('Choose a file to convert', self)
        self.openButton.clicked.connect(self.openFileDialog)
        self.layout.addWidget(self.openButton)
        
        self.convertButton = QPushButton('Convert', self)
        self.convertButton.clicked.connect(self.convertVideoFromButton)
        self.layout.addWidget(self.convertButton)
        
        self.setLayout(self.layout)
        self.setWindowTitle('vidcord')
        self.show()
    
    def dragEnterEvent(self, event: QDragEnterEvent):
        if event.mimeData().hasUrls():
            event.acceptProposedAction()
    
    def dropEvent(self, event: QDropEvent):
        urls = event.mimeData().urls()
        if urls:
            file_path = urls[0].toLocalFile()
            self.convertVideo(file_path)

    def openFileDialog(self):
        options = QFileDialog.Options()
        fileName, _ = QFileDialog.getOpenFileName(self, "Choose a video file to convert", "", "All Files (*);;Video Files (*.mp4 *.avi)", options=options)
        if fileName:
            self.file_path = fileName
            self.label.setText(f'Selected file: {fileName}')
            
    def convertVideoFromButton(self):
        if self.file_path:
            self.convertVideo(self.file_path)
        else:
            self.label.setText("No file selected for conversion")

    def convertVideo(self, filePath):
        quality = self.qualityComboBox.currentText()
        if "Low" in quality:
            target_size_mb = 25
            resolution = "480p"
        else:
            target_size_mb = 50
            resolution = "720p"
            
        duration = get_video_duration(filePath)
        target_bitrate = calculate_bitrate(target_size_mb, duration)
        
        options = QFileDialog.Options()
        output_file, _ = QFileDialog.getSaveFileName(self, "Save Converted Video", "", "MP4 Files (*.mp4);;All Files (*)", options=options)
        if not output_file:
            self.label.setText("Conversion cancelled")
            return

        command = [
            'ffmpeg', '-i', filePath, '-c:v', self.encoder, '-b:v', f'{target_bitrate}k', '-maxrate', f'{target_bitrate}k',
            '-bufsize', f'{2*target_bitrate}k', '-vf', f'scale=-1:{resolution}', output_file
        ]
        subprocess.run(command)
        self.label.setText(f'Conversion complete: {output_file}')
        
        self.copyToClipboard(os.path.abspath(output_file))
        self.showInFileExplorer(output_file)

    def copyToClipboard(self, filePath):
        clipboard = QApplication.clipboard()
        clipboard.setText(filePath, QClipboard.Clipboard)
        self.label.setText(f'Conversion complete: {filePath} (copied to clipboard)')

    def showInFileExplorer(self, filePath):
        abs_path = os.path.abspath(filePath)
        if sys.platform == 'win32':
            subprocess.run(['explorer', '/select,', abs_path])
        elif sys.platform == 'darwin':
            subprocess.run(['open', '-R', abs_path])
        elif sys.platform.startswith('linux'):
            subprocess.run(['xdg-open', os.path.dirname(abs_path)])

if __name__ == '__main__':
    app = QApplication(sys.argv)
    file_path = sys.argv[1] if len(sys.argv) > 1 else None
    ex = vidcord(file_path)
    sys.exit(app.exec_())
