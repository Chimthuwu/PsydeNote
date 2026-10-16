call Z:/msvc/msvc/setup_x64.bat
cd /d "Z:\GITHUB\AUDIO · FAZE-SYNTHESIZER\spike\elementary\plugin"
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER=cl -DCMAKE_CXX_COMPILER=cl -DCMAKE_MAKE_PROGRAM=ninja -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DCMAKE_CXX_FLAGS="/EHsc"
cmake --build build --config Release -j 6
