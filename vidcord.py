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
    target_size_kb *= 8  # Convert MB to kb (1 byte = 8 bits)
    bitrate = target_size_kb / duration_sec  # kbps
    return int(bitrate)

class FFmpegGUI(QWidget):
    def __init__(self, file_path=None):
        super().__init__()

        self.file_path = file_path
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
        
        self.convertButton = QPushButton('Convert', self)
        self.convertButton.clicked.connect(self.openFileDialog)
        self.layout.addWidget(self.convertButton)
        
        if self.file_path:
            self.convertVideo(self.file_path)
        
        self.setLayout(self.layout)
        self.setWindowTitle('FFmpeg GUI')
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
        fileName, _ = QFileDialog.getOpenFileName(self, "QFileDialog.getOpenFileName()", "", "All Files (*);;Video Files (*.mp4 *.avi)", options=options)
        if fileName:
            self.convertVideo(fileName)
            
    def convertVideo(self, filePath):
        quality = self.qualityComboBox.currentText()
        if "Low" in quality:
            target_size_mb = 25  # Target file size in MB
            resolution = "480p"
        else:
            target_size_mb = 50  # Target file size in MB
            resolution = "720p"
            
        duration = get_video_duration(filePath)
        target_bitrate = calculate_bitrate(target_size_mb, duration)
        
        output_file = 'output.mp4'
        command = [
            'ffmpeg', '-i', filePath, '-b:v', f'{target_bitrate}k', '-maxrate', f'{target_bitrate}k',
            '-bufsize', f'{2*target_bitrate}k', '-vf', f'scale=-1:{resolution}', output_file
        ]
        subprocess.run(command)
        self.label.setText(f'Conversion complete: {output_file}')
        
        # Copy the path of the converted file to the clipboard
        self.copyToClipboard(os.path.abspath(output_file))

    def copyToClipboard(self, filePath):
        clipboard = QApplication.clipboard()
        clipboard.setText(filePath, QClipboard.Clipboard)
        self.label.setText(f'Conversion complete: {filePath} (copied to clipboard)')

if __name__ == '__main__':
    app = QApplication(sys.argv)
    file_path = sys.argv[1] if len(sys.argv) > 1 else None
    ex = FFmpegGUI(file_path)
    sys.exit(app.exec_())