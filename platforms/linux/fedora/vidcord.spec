Name:           vidcord
Version:        5.3
Release:        1%{?dist}
Summary:        Video Compressor

License:        MIT
URL:            https://github.com/cyroz1/vidcord
# Source0:        https://github.com/cyroz1/vidcord/archive/v%{version}.tar.gz
# note: we are packaging the pre-built binary for simplicity in this script context

Requires:       ffmpeg
Requires:       python3
Requires:       python3-pyqt5

%description
VidCord is a video compressor and converter tool using FFmpeg and PyQt5.

%prep
# No prep needed if we assume binary is ready, but normally we'd unpack source.

%build
# No build step here, assuming we copy pre-built stuff or build in install.

%install
rm -rf $RPM_BUILD_ROOT
mkdir -p $RPM_BUILD_ROOT/opt/vidcord
mkdir -p $RPM_BUILD_ROOT/usr/bin
mkdir -p $RPM_BUILD_ROOT/usr/share/applications
mkdir -p $RPM_BUILD_ROOT/usr/share/pixmaps

# Assuming sources are available in BUILDROOT or we just copy from local dist
# This is tricky without a true rpmbuild environment. 
# We'll assume the user places the 'dist/vidcord' binary in a specific place.
# For this template to be useful, it describes where files GO.

# copy binary
# install -m 755 vidcord $RPM_BUILD_ROOT/opt/vidcord/vidcord
# ln -s /opt/vidcord/vidcord $RPM_BUILD_ROOT/usr/bin/vidcord

%files
/opt/vidcord
/usr/bin/vidcord
