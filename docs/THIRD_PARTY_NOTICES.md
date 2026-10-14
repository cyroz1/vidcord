# Third-party notices

## FFmpeg WebAssembly

The hosted browser bundle serves `@ffmpeg/core` version `0.12.10` or later, a WebAssembly
build of FFmpeg licensed under the GNU General Public License version 2 or
later. The package is published from the [ffmpeg.wasm repository](https://github.com/ffmpegwasm/ffmpeg.wasm).

The browser runtime also uses `@ffmpeg/ffmpeg`, an MIT-licensed package from
that repository. Its notices and source are available
through the package distribution and repository.

## Linux AppImage media runtime

Linux AppImages bundle GStreamer 1.0 runtime components and the `base`, `good`,
and `libav` plugin packages so WebKitGTK can play local HTML video. GStreamer
and its official plugin modules are licensed under LGPL 2.1; plugins that use
external codec libraries retain those libraries' separate licenses. See the
[GStreamer licensing FAQ](https://gstreamer.freedesktop.org/documentation/frequently-asked-questions/licensing.html)
and the copyright files for the Ubuntu packages used to build each AppImage.
This media runtime does not include the `ffmpeg` or `ffprobe` command-line
programs required by the desktop app for probing and compression.
