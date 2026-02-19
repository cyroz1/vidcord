import time
import sys
import os

def benchmark():
    print("--- Benchmarking vidcord.py ---")
    
    # 1. Measure Import Time
    start_time = time.time()
    try:
        # We need to add the current directory to sys.path
        sys.path.append(os.getcwd())
        import vidcord
    except ImportError as e:
        print(f"Import failed: {e}")
        return
    end_time = time.time()
    import_time = end_time - start_time
    print(f"Import Time (Startup): {import_time:.4f} seconds")
    
    # 2. Measure GPU Detection (First Call - Cached or not depends on import)
    # Since we imported, the class is loaded.
    from vidcord import VideoProcessor
    
    # Reset cache to test "Cold" detection if we wanted, but we want to see if the cache works 
    # as expected during app usage. 
    # Actually, we SHOULD test 'cold' vs 'cached' explicitly to show the benefit.
    
    VideoProcessor._gpu_cache = None
    print("\n--- Testing GPU Detection ---")
    
    start_time = time.time()
    # This might print error logs if lspci fails on mac, which is expected
    gpus_cold = VideoProcessor.get_system_gpus() 
    end_time = time.time()
    cold_time = end_time - start_time
    print(f"Cold GPU Detection Time: {cold_time:.4f} seconds")
    
    # 3. Measure GPU Detection (Cached)
    start_time = time.time()
    gpus_warm = VideoProcessor.get_system_gpus()
    end_time = time.time()
    warm_time = end_time - start_time
    print(f"Warm (Cached) GPU Detection Time: {warm_time:.6f} seconds")
    
    if warm_time < 0.001:
        print("=> Caching is working effectively.")
    else:
        print("=> Caching might NOT be working.")

    # 4. Verify FFmpeg Setup (Async Check)
    print("\n--- Testing FFmpeg Setup ---")
    start_time = time.time()
    VideoProcessor.setup_ffmpeg_path()
    end_time = time.time()
    print(f"FFmpeg Setup (PATH Check) Time: {end_time - start_time:.4f} seconds")

if __name__ == "__main__":
    benchmark()
