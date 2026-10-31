"""Read-only pixel analysis: writes source rectangles/anchors, never changes PNGs."""
from pathlib import Path
import json
import numpy as np
from PIL import Image
from scipy.ndimage import label, find_objects

ROOT = Path(__file__).resolve().parent
POSES = ['idle', 'walk_left', 'walk_right', 'run', 'prepare', 'impact', 'gather', 'rest']
DIRECTIONS = ['south', 'north', 'east']

def measure(name, count, body_height):
    image = Image.open(ROOT / f'{name}.png').convert('RGBA')
    rgba = np.array(image); alpha = rgba[:, :, 3]
    labels, _ = label(alpha > 100, structure=np.ones((3, 3)))
    sizes = np.bincount(labels.ravel()); boxes = find_objects(labels)
    parts = []
    for i in np.argsort(sizes[1:])[::-1] + 1:
        if sizes[i] < 1500: break
        b = boxes[i - 1]
        parts.append((i, [b[1].start, b[0].start, b[1].stop, b[0].stop]))
    assert len(parts) == count, (name, len(parts), count)
    parts.sort(key=lambda p: p[1][1] + p[1][3])
    rows = [sorted(parts[i:i+3], key=lambda p: p[1][0]) for i in range(0, count, 3)]
    scale = body_height / np.mean([p[1][3] - p[1][1] for p in rows[0]])
    result = []
    for row_index, row in enumerate(rows):
        poses = []
        for col, (part, bounds) in enumerate(row):
            x, y, r, b = bounds; w, h = r-x, b-y
            # Keep antialiased contour pixels. Full original sheet is still used.
            left, top, right, bottom = max(0,x-2), max(0,y-2), min(image.width,r+2), min(image.height,b+2)
            # A few hand-drawn rows are not perfectly aligned. Tighten sampling
            # at the transparent row boundary so a neighbouring boot/hair tip
            # cannot leak into this pose. This only changes source rectangles;
            # the original PNG remains byte-for-byte unchanged.
            for other, other_bounds in parts:
                if other == part: continue
                yy, xx = np.where(labels[top:bottom,left:right] == other)
                if not len(yy): continue
                own_count = sizes[part]
                if other_bounds[1]+other_bounds[3] < y+b:
                    proposed = top+int(yy.max())+1
                    loss = np.count_nonzero(labels[top:proposed,left:right] == part)
                    if proposed-y <= h*.07 and loss/own_count < .02: top=proposed
                else:
                    proposed = top+int(yy.min())
                    loss = np.count_nonzero(labels[proposed:bottom,left:right] == part)
                    if b-proposed <= h*.07 and loss/own_count < .02: bottom=proposed
            bottom_pixels = np.where((labels[max(y,b-round(h*.15)):b, x:r] == part).any(axis=0))[0]
            foot_x = x + (float(bottom_pixels[0]+bottom_pixels[-1])/2 if len(bottom_pixels) else w/2)
            anchor = {'x':round(foot_x-left,2), 'y':min(b,bottom)-top-2}
            poses.append({'x':left, 'y':top, 'w':right-left, 'h':bottom-top, 'anchor':anchor,
                          '_bounds':bounds, '_part':int(part)})
        result.append(poses)
    return {'sheet_width':image.width,'sheet_height':image.height,'native_scale':round(float(scale),7),
            'alpha_zero_fraction':round(float((alpha==0).mean()),5),'rows':result}, rgba

def attach(name, data, rgba):
    guides = [
        [(.73,.79),(.73,.79),(.60,.79)],
        [(.73,.77),(.73,.77),(.73,.75)],
        [(.73,.77),(.73,.77),(.70,.75)],
        [(.88,.53),(.88,.53),(.86,.55)],
        [(.88,.45),(.88,.45),(.92,.45)],
        [(.95,.50),(.95,.50),(.96,.50)],
        [(.54,.93),(.70,.88),(.84,.90)],
        [(.53,.89),(.70,.86),(.74,.75)],
    ]
    for row_index,row in enumerate(data['rows']):
        for col,frame in enumerate(row):
            if frame.get('image'):continue
            x,y,r,b=frame['_bounds'];w,h=r-x,b-y
            rgb=rgba[y:b,x:r,:3].astype(float); a=rgba[y:b,x:r,3]
            skin=(rgb[:,:,0]>145)&(rgb[:,:,1]>100)&(rgb[:,:,2]>65)&(rgb[:,:,0]-rgb[:,:,1]>4)&(rgb[:,:,0]-rgb[:,:,1]<85)&(rgb[:,:,1]-rgb[:,:,2]>4)&(a>170)
            labels,_=label(skin,structure=np.ones((3,3)));sizes=np.bincount(labels.ravel());boxes=find_objects(labels)
            candidates=[]
            for i,box in enumerate(boxes,1):
                if box is None or sizes[i]<8:continue
                cy=(box[0].start+box[0].stop)/2;cx=(box[1].start+box[1].stop)/2
                if .36*h<cy and sizes[i]<650 and box[0].stop-box[0].start<.22*h and box[1].stop-box[1].start<.25*h:candidates.append((cx,cy))
            guide=guides[row_index][col]
            if row_index==4 and col==0 and name in ['wanderer_1','wanderer_2']:guide=(.18,.5)
            gx,gy=guide[0]*w,guide[1]*h
            nearest=min(candidates,key=lambda p:(p[0]-gx)**2+(p[1]-gy)**2) if candidates else (gx,gy)
            if (nearest[0]-gx)**2+(nearest[1]-gy)**2>(h*.22)**2:nearest=(gx,gy)
            hand={'x':round(x+nearest[0]-frame['x'],2),'y':round(y+nearest[1]-frame['y'],2),'rotation':0}
            # Equipment follows the garment and hair, never the hitbox or state.
            center=frame['anchor']['x']
            chest={'x':round(center,2),'y':round(y+h*(.68 if row_index<6 else .65)-frame['y'],2)}
            head={'x':round(center+w*.06,2),'y':round(y+h*.20-frame['y'],2)}
            frame['attachments']={'hand':hand,'chest':chest,'head':head}

data={}
for number in range(1,9):
    name=f'wanderer_{number}';result,rgba=measure(name,21 if number in [3,4] else 24,52)
    if number in [3,4]:
        # Supplement is measured independently; no resized/composited PNG exists.
        supplement,supplement_rgba=measure('actor_preparation',6,52)
        extra=supplement['rows'][number-3]
        extra_height=np.mean([f['_bounds'][3]-f['_bounds'][1] for f in extra])
        for frame in extra:
            frame.update({'image':'/pixel-world/ink_actor_preparation.png','sheet_width':1536,'sheet_height':1024,'native_scale':round(float(52/extra_height),7)})
        result['rows'].insert(4,extra)
        attach(name,result,rgba)
        # The supplemental fist was checked against its separate large drawing.
        for col,frame in enumerate(extra):
            x,y,r,b=frame['_bounds'];frame['attachments']={'hand':{'x':round((r-x)*.80+2,2),'y':round((b-y)*.49+2,2),'rotation':0},'chest':{'x':frame['anchor']['x'],'y':round((b-y)*.64+2,2)},'head':{'x':frame['anchor']['x'],'y':round((b-y)*.18+2,2)}}
    else:attach(name,result,rgba)
    result['pose_names']=POSES;data[name]=result
for name,height in [('forest_slime',32),('forest_boar',43),('ruins_guardian',58)]:
    result,_=measure(name,21,height);result['pose_names']=['idle','walk_left','walk_right','run','prepare','impact','hurt'];data[name]=result
for result in data.values():
    for row in result['rows']:
        for frame in row:
            frame.pop('_bounds',None);frame.pop('_part',None)
(ROOT/'actor-geometry.json').write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
print(json.dumps({k:{'poses':len(v['rows'])*3,'scale':v['native_scale'],'transparent':v['alpha_zero_fraction']} for k,v in data.items()},indent=2))
