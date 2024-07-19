import sys
import subprocess
import shlex
from PyQt5.QtWidgets import QApplication, QWidget, QPushButton, QVBoxLayout, QFileDialog, QLabel

def get_video_duration(file_path):
    command = f'ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "{file_path}"'
    result = subprocess.run(shlex.split(command), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return float(result.stdout.strip())

def calculate_bitrate(target_size_mb, duration_sec):
    target_size_kb = target_size_mb * 1024
    target_size_kb *= 8  # Convert MB to kb (1 byte = 8 bits)
    bitrate = target_size_kb / duration_sec  # kbps
    return int(bitrate)

class vidcord(QWidget):
    def __init__(self, file_path=None):
        super().__init__()

        self.file_path = file_path
        self.initUI()
        
    def initUI(self):
        self.layout = QVBoxLayout()
        
        self.label = QLabel('Select a video file to convert', self)
        self.layout.addWidget(self.label)
        
        if self.file_path:
            self.convertVideo(self.file_path)
        else:
            self.btn = QPushButton('Open File', self)
            self.btn.clicked.connect(self.openFileDialog)
            self.layout.addWidget(self.btn)
        
        self.setLayout(self.layout)
        
        self.setWindowTitle('FFmpeg GUI')
        self.show()
        
    def openFileDialog(self):
        options = QFileDialog.Options()
        fileName, _ = QFileDialog.getOpenFileName(self, "QFileDialog.getOpenFileName()", "", "All Files (*);;Video Files (*.mp4 *.avi)", options=options)
        if fileName:
            self.convertVideo(fileName)
            
    def convertVideo(self, filePath):
        target_size_mb = 25  # Target file size in MB
        duration = get_video_duration(filePath)
        target_bitrate = calculate_bitrate(target_size_mb, duration)
        
        output_file = 'output.mp4'
        command = [
            'ffmpeg', '-i', filePath, '-b:v', f'{target_bitrate}k', '-maxrate', f'{target_bitrate}k', 
            '-bufsize', f'{2*target_bitrate}k', output_file
        ]
        subprocess.run(command)
        self.label.setText(f'Conversion complete: {output_file}')

if __name__ == '__main__':
    app = QApplication(sys.argv)
    file_path = sys.argv[1] if len(sys.argv) > 1 else None
    ex = vidcord(file_path)
    sys.exit(app.exec_())