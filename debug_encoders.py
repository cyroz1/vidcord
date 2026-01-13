import platform
import subprocess
import shlex
import os

def get_system_gpus():
    gpus = {'nvidia': False, 'amd': False, 'intel': False, 'apple': False}
    try:
        if platform.system() == 'Darwin':
            cmd = ['system_profiler', 'SPDisplaysDataType']
            output = subprocess.check_output(cmd).decode('utf-8').lower()
            print(f"DEBUG: system_profiler output length: {len(output)}")
            print(f"DEBUG: system_profiler output snippet: {output[:500]}")
            if 'nvidia' in output: gpus['nvidia'] = True
            if 'amd' in output or 'radeon' in output: gpus['amd'] = True
            if 'intel' in output: gpus['intel'] = True
            if 'apple' in output or 'm1' in output or 'm2' in output or 'm3' in output or 'm4' in output: gpus['apple'] = True
    except Exception as e:
        print(f"GPU detection failed: {e}")
    return gpus

def get_available_encoders():
    try:
        encoders_output = subprocess.run(
            shlex.split('ffmpeg -hide_banner -encoders'),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        ).stdout
        print(f"DEBUG: ffmpeg encoders output length: {len(encoders_output)}")
    except FileNotFoundError:
        print("DEBUG: ffmpeg NOT FOUND")
        return []

    gpus = get_system_gpus()
    print(f"DEBUG: Detected GPUs: {gpus}")
    
    encoder_labels = {'libx264': 'CPU (libx264)'}
    if gpus['nvidia']: encoder_labels['h264_nvenc'] = 'NVIDIA (h264_nvenc)'
    if gpus['amd']: encoder_labels['h264_amf'] = 'AMD (h264_amf)'
    if platform.system() == 'Darwin':
        encoder_labels['h264_videotoolbox'] = 'Apple Silicon (h264_videotoolbox)' if gpus['apple'] else 'Hardware (h264_videotoolbox)'
    if gpus['intel']: encoder_labels['h264_qsv'] = 'Intel (h264_qsv)'

    available_encoders = []
    for encoder in encoder_labels.keys():
        if encoder == 'libx264' or encoder in encoders_output:
            available_encoders.append((encoder, encoder_labels[encoder]))
    return available_encoders

if __name__ == "__main__":
    print(f"Platform: {platform.system()}")
    encoders = get_available_encoders()
    print(f"Available Encoders: {encoders}")
