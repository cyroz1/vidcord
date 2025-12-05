#!/bin/bash
# linux/fedora/build_rpm.sh

echo "Building RPM requires a strict directory setup (rpmbuild). "
echo "Please refer to the vidcord.spec file."
echo "You generally need to:"
echo "1. Run linux/build.sh to generate the binary."
echo "2. Setup your rpmbuild tree (rpmdev-setuptree)."
echo "3. Place sources and use 'rpmbuild -ba vidcord.spec'."
echo ""
echo "Note: The correct output naming convention is vidcord_v(version)_(arch).rpm"
