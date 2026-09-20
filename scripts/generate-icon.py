"""Original Motuo artwork; generated locally, no third-party imagery."""
from pathlib import Path
import json, math
from PIL import Image, ImageDraw, ImageFilter
root=Path(__file__).resolve().parents[1]
n=1024
base=Image.new('RGB',(n,n)); pixels=base.load()
for y in range(n):
 for x in range(n):
  a=math.exp(-(((x-520)/430)**2+((y-400)/440)**2))
  b=math.exp(-(((x-740)/300)**2+((y-770)/210)**2))
  pixels[x,y]=(int(4+4*a+17*b),int(8+13*a+3*b),int(17+26*a+22*b))
glow=Image.new('RGBA',(n,n)); d=ImageDraw.Draw(glow)
# Two precise segmented arcs surround the road-shaped M.
d.arc((153,137,871,855),192,344,fill=(71,230,255,255),width=21)
d.arc((153,137,871,855),348,365,fill=(184,119,255,255),width=21)
d.arc((194,178,830,814),192,345,fill=(71,230,255,100),width=3)
path=[(292,656),(361,367),(511,537),(661,367),(731,656)]
d.line(path,fill=(91,235,255,255),width=43,joint='curve')
d.line([(366,653),(396,524),(511,654),(628,523),(658,653)],fill=(154,112,255,255),width=18,joint='curve')
blur=glow.filter(ImageFilter.GaussianBlur(20))
base=Image.alpha_composite(base.convert('RGBA'),blur)
base=Image.alpha_composite(base,glow)
d=ImageDraw.Draw(base)
for angle in range(195,346,15):
 a=math.radians(angle)
 p=(512+327*math.cos(a),496+327*math.sin(a));q=(512+310*math.cos(a),496+310*math.sin(a))
 d.line([p,q],fill=(90,184,211,160),width=4)
d.rounded_rectangle((450,758,574,767),radius=4,fill=(104,219,242))
asset=root/'ios/Motuo/Assets.xcassets/AppIcon.appiconset';asset.mkdir(parents=True,exist_ok=True)
base.convert('RGB').save(asset/'AppIcon.png')
(asset/'Contents.json').write_text(json.dumps({'images':[{'filename':'AppIcon.png','idiom':'universal','platform':'ios','size':'1024x1024'}],'info':{'author':'xcode','version':1}},indent=2))
watch=root/'ios/MotuoWatch/Assets.xcassets/AppIcon.appiconset';watch.mkdir(parents=True,exist_ok=True)
base.convert('RGB').save(watch/'AppIcon.png')
(watch/'Contents.json').write_text(json.dumps({'images':[{'filename':'AppIcon.png','idiom':'universal','platform':'watchos','size':'1024x1024'}],'info':{'author':'xcode','version':1}},indent=2))
print(asset/'AppIcon.png')
