import math

def calculate_bitrate(target_size_mb, duration_sec, audio_bitrate=128, remove_audio=False):
    target_size_kb = target_size_mb * 1024 * 8
    if remove_audio:
        audio_bitrate_kb = 0
    else:
        audio_bitrate_kb = audio_bitrate * duration_sec
    
    video_bitrate = (target_size_kb - audio_bitrate_kb) / duration_sec
    return max(100, int(video_bitrate * 0.9))

# Test cases
tests = [
    (10, 60, False),    # Normal case: 10MB, 1 min
    (10, 3600, False),  # Long video: 10MB, 1 hour (would have been negative/very low)
    (5, 10, True),      # Small target, short duration, no audio
]

for size, dur, no_audio in tests:
    br = calculate_bitrate(size, dur, remove_audio=no_audio)
    print(f"Size: {size}MB, Duration: {dur}s, No Audio: {no_audio} -> Bitrate: {br}kbps")
