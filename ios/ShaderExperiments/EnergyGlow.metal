#include <metal_stdlib>
using namespace metal;
[[ stitchable ]] half4 energyGlow(float2 position, half4 color, float2 size, float time, float intensity) {
    float2 uv = position / max(size, float2(1));
    float2 p = (uv - float2(0.5,0.55)) * float2(1.0,1.25);
    float glow = exp(-dot(p,p)*12.0) * (0.045 + intensity*0.065);
    float pulse = 0.9 + sin(time*0.6)*0.1;
    return half4(color.rgb + half3(0.34,0.88,0.48)*half(glow*pulse),color.a);
}
