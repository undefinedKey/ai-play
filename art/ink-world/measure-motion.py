"""Read-only PNG measurements; writes sampling metadata, never edits pixels.

Requires Pillow, numpy and scipy. Run from any directory; --allow-missing is
only for inspecting a partially generated batch. The default requires all 8.
Source hashes make stale geometry fail visibly when a sheet is regenerated.
"""
from pathlib import Path
import argparse
import hashlib
import json
import numpy as np
from PIL import Image
from scipy.ndimage import label, find_objects

ROOT = Path(__file__).resolve().parent
POSES = ['walk_passing_left', 'walk_passing_right', 'run_opposite_flight', 'hurt_standing', 'work_followthrough']
DIRECTIONS = ['south', 'north', 'east']
# These are anatomical search regions, not equal-cell crop assumptions. The
# selected skin component is checked in the browser overlay before release.
HAND_GUIDES = [
    [(0.78, 0.62), (0.83, 0.65), (0.84, 0.56)],
    [(0.78, 0.65), (0.83, 0.65), (0.84, 0.56)],
    [(0.88, 0.54), (0.88, 0.56), (0.78, 0.59)],
    [(0.83, 0.54), (0.82, 0.54), (0.80, 0.61)],
    [(0.61, 0.71), (0.76, 0.73), (0.87, 0.70)],
]


# Reviewed palm/grip centers in original sheet pixels. Brow/cheek fragments
# and ochre coat highlights can pass the automatic skin filter, so these
# measured points override only the ambiguous cases seen in browser overlays.
HAND_REVIEW = {
    'wanderer_1': {
        (3,1): (557.33, 1048.00),
        (3,2): (910.67, 1057.33),
    },
    'wanderer_2': {
        (0,0): (269.33, 209.33),
        (0,1): (473.33, 209.33),
        (2,0): (256.00, 784.00),
        (2,2): (929.33, 754.67),
        (3,0): (249.33, 1028.00),
        (3,1): (561.33, 1032.00),
        (3,2): (849.33, 1028.00),
        (4,1): (474.67, 1401.33),
    },
    'wanderer_3': {
        (2,1): (456.00, 801.33),
        (3,1): (565.33, 1088.00),
        (4,1): (528.00, 1430.67),
    },
    'wanderer_4': {
        (0,2): (877.33, 205.33),
        (3,0): (214.67, 1052.00),
        (3,1): (562.67, 1048.00),
    },
    'wanderer_5': {
        (2,0): (337.33, 768.00),
        (2,1): (598.67, 752.00),
        (2,2): (928.00, 770.67),
        (3,0): (318.67, 1041.33),
        (3,1): (612.00, 1029.33),
        (3,2): (916.00, 1052.00),
        (4,1): (528.00, 1429.33),
    },
    'wanderer_6': {
        (0,0): (226.67, 164.00),
        (2,0): (260.00, 744.00),
        (2,1): (590.67, 794.67),
        (2,2): (929.33, 764.00),
        (3,0): (284.00, 1072.00),
        (3,1): (581.33, 1070.67),
        (3,2): (952.00, 1077.33),
    },
    'wanderer_7': {
        (0,0): (292.00, 216.00),
        (0,1): (554.67, 220.00),
        (2,2): (925.33, 760.00),
        (3,0): (300.00, 1041.33),
        (3,1): (450.67, 1021.33),
    },
    'wanderer_8': {
        (3,0): (222.67, 1028.00),
        (3,1): (605.33, 1026.67),
        (3,2): (865.33, 1036.00),
    },
}

# Flying legs may connect through the crotch or split a bent shin into a third
# component. These reviewed midpoints use the two actual boot soles, not an
# extremum of the lower silhouette. Values are original sheet X coordinates.
FLIGHT_FOOT_X = {
    'wanderer_1': [207.33, 544.00, 867.33],
    'wanderer_2': [202.00, 532.67, 802.00],
    'wanderer_3': [202.67, 519.33, 844.67],
    'wanderer_4': [198.67, 518.67, 855.33],
    'wanderer_5': [222.00, 523.33, 821.33],
    'wanderer_6': [185.33, 522.67, 812.67],
    'wanderer_7': [186.67, 507.33, 821.33],
    'wanderer_8': [200.67, 527.33, 842.67],
}
# Manual anatomical anchors are valid only for the reviewed source bytes.
REVIEWED_SOURCE_HASHES = {
    'wanderer_1': 'c93da78e67634b190bea566f7582dbd34cdffd6f5ed2556b6e77e3e7ac037e62',
    'wanderer_2': '713557c8a03d0ef3700f7ace819a41bf25f8d6bd5337d8412bcf9840543bf236',
    'wanderer_3': '88264b26e28eae2a4b7fb8437a86b0d86746c5ba7a5f40014d8fe054c1daddf0',
    'wanderer_4': 'e0dfcec81c68cb78b0ed918667bf6dd46b8df5fcdc9959591d1cc812d9735242',
    'wanderer_5': 'b8ee45894410a065631cef6b4d0d7da1610dc6b794f863330644cb758b9cd163',
    'wanderer_6': '18af15a8108ff54e48bd7ad2e5b72f79d17210356310b25ee11b8d4d623027d9',
    'wanderer_7': 'e0f4ba730d1a968ec9b8f67d13aa608f68f168a86c3ebbb52f6c29d1d8e6a2ab',
    'wanderer_8': '289ded651a3b6536d9927db7c9ea3870171bc6a0c6914153daac1205b85886da',
}

def components(mask, minimum=1):
    labels, _ = label(mask, structure=np.ones((3, 3)))
    sizes, boxes = np.bincount(labels.ravel()), find_objects(labels)
    return labels, [(i, int(sizes[i]), [b[1].start, b[0].start, b[1].stop, b[0].stop])
                    for i, b in enumerate(boxes, 1) if b is not None and sizes[i] >= minimum]


def median_x(mask, top, bottom):
    ys, xs = np.where(mask[max(0, top):min(mask.shape[0], bottom)])
    return float(np.median(xs)) if len(xs) else mask.shape[1] / 2


def foot_contact(mask, row):
    """Find actual support soles; leaning torso/hands never move the foot."""
    h, w = mask.shape
    # Separate actual boots below the connected crotch. A fixed left/right
    # split would count one off-center boot twice in backward-leaning poses.
    band = int(h * (0.78 if row == 2 else 0.87 if row >= 3 else 0.80))
    lower = mask.copy(); lower[:band] = False
    labels, parts = components(lower, max(12, int(h * w * 0.0007)))
    feet = []
    for part, size, (x, y, r, b) in parts:
        if b < h * (0.76 if row == 2 else 0.88):
            continue
        # Median of the sole's last 2% of figure height, not the entire boot or
        # the left/right extreme of a raised knee.
        yy, xx = np.where(labels[max(y, b-max(3, round(h*.018))):b] == part)
        if len(xx): feet.append((float(np.median(xx)), float(b-1), size))
    if not feet:
        yy, xx = np.where(mask[max(0, h-max(3, round(h*.02))):])
        assert len(xx), 'No visible support sole'
        return float(np.median(xx)), float(h-1), 'lowest_visible_sole'
    feet.sort(key=lambda value: value[1], reverse=True)
    if row in (0, 1):
        # Passing poses have one grounded boot and one raised boot.
        feet = [f for f in feet if feet[0][1]-f[1] <= h*.025]
    elif row != 2:
        feet = [f for f in feet if feet[0][1]-f[1] <= h*.12]
    feet = sorted(feet, key=lambda value: value[2], reverse=True)[:2]
    return float(np.mean([f[0] for f in feet])), float(max(f[1] for f in feet)), 'support_sole_midpoint' if len(feet)>1 else 'single_support_sole'


def attachments(rgba, mask, row, col):
    h, w = mask.shape
    rgb = rgba[:, :, :3].astype(float)
    skin = ((rgb[:, :, 0] > 145) & (rgb[:, :, 1] > 95) & (rgb[:, :, 2] > 55)
            & (rgb[:, :, 0]-rgb[:, :, 1] > 4) & (rgb[:, :, 0]-rgb[:, :, 1] < 90)
            & (rgb[:, :, 1]-rgb[:, :, 2] > 3) & (rgba[:, :, 3] > 170) & mask)
    skin[:int(h*(.49 if row == 2 else .53 if row == 3 else .40))] = False
    labels, regions = components(skin, 7)
    candidates = []
    for part, size, (x, y, r, b) in regions:
        if size > h*h*.032 or b-y > h*.19 or r-x > w*.30:
            continue
        yy, xx = np.where(labels == part)
        candidates.append((float(np.median(xx)), float(np.median(yy)), size))
    gx, gy = HAND_GUIDES[row][col]
    guide = (gx*w, gy*h)
    near = min(candidates, key=lambda p:(p[0]-guide[0])**2+(p[1]-guide[1])**2) if candidates else guide
    hand = near[:2] if np.hypot(near[0]-guide[0], near[1]-guide[1]) < h*.20 else guide
    # The median silhouette mass at garment/head heights follows a leaning
    # torso instead of borrowing the grounded feet's horizontal coordinate.
    chest = (median_x(mask, int(h*.55), int(h*.70)), h*.64)
    head = (median_x(mask, int(h*.07), int(h*.36)), h*.20)
    return {'hand': hand, 'chest': chest, 'head': head}, candidates


def measure(identity):
    path = ROOT / f'motion-{identity}.png'
    original = path.read_bytes()
    assert hashlib.sha256(original).hexdigest() == REVIEWED_SOURCE_HASHES[identity], f'{identity}: regenerated source requires a new anatomical review'
    image = Image.open(path).convert('RGBA')
    rgba = np.array(image); alpha = rgba[:, :, 3]
    labels, parts = components(alpha > 100, 1500)
    assert len(parts) == 15, (identity, 'expected 15 isolated figures', len(parts))
    parts.sort(key=lambda p:p[2][1]+p[2][3])
    rows = [sorted(parts[i:i+3], key=lambda p:p[2][0]) for i in range(0, 15, 3)]
    reference_heights = [b-y for row in rows[:2] for _, _, (_, y, _, b) in row]
    scale = round(52 / float(np.mean(reference_heights)), 7)
    result, diagnostics = [], []
    for row_index, row in enumerate(rows):
        frames = []
        for col, (part, size, bounds) in enumerate(row):
            x, y, r, b = bounds; w, h = r-x, b-y
            gutter_trim_pixels = 0
            left, top, right, bottom = max(0, x-2), max(0, y-2), min(image.width, r+2), min(image.height, b+2)
            # Transparent gutters are measured per silhouette, never by slicing
            # a nominal 341x307 cell that could cut a hat or adjacent raised boot.
            for other, _, other_bounds in parts:
                if other == part: continue
                yy, xx = np.where(labels[top:bottom, left:right] == other)
                if not len(yy): continue
                if other_bounds[1]+other_bounds[3] < y+b:
                    proposed = top+int(yy.max())+1
                    loss = int(np.count_nonzero(labels[top:proposed, left:right] == part))
                    assert loss/size < .001, (identity, row_index, col, 'overlapping upper figure', loss/size)
                    gutter_trim_pixels += loss
                    top = proposed
                else:
                    proposed = top+int(yy.min())
                    loss = int(np.count_nonzero(labels[proposed:bottom, left:right] == part))
                    assert loss/size < .001, (identity, row_index, col, 'overlapping lower figure', loss/size)
                    gutter_trim_pixels += loss
                    bottom = proposed
            mask = labels[y:b, x:r] == part
            # If a few subpixel contour tips were excluded at a shared gutter,
            # the measured sole and attachments must use the visible remainder.
            mask[:max(0, top-y)] = False
            mask[max(0, bottom-y):] = False
            mask[:, :max(0, left-x)] = False
            mask[:, max(0, right-x):] = False
            fx, fy, foot_method = foot_contact(mask, row_index)
            if row_index == 2:
                fx = FLIGHT_FOOT_X[identity][col]-x
                foot_method = 'reviewed_flight_sole_midpoint'
            slots, candidates = attachments(rgba[y:b, x:r], mask, row_index, col)
            reviewed_hand = HAND_REVIEW.get(identity, {}).get((row_index, col))
            if reviewed_hand: slots['hand'] = (reviewed_hand[0]-x, reviewed_hand[1]-y)
            convert = lambda point: {'x':round(x+point[0]-left, 2), 'y':round(y+point[1]-top, 2)}
            attached = {slot:convert(point) for slot, point in slots.items()}
            attached['hand']['rotation'] = 0
            frame = {'x':left, 'y':top, 'w':right-left, 'h':bottom-top,
                     'anchor':convert((fx, fy)), 'attachments':attached,
                     'image':f'/pixel-world/ink_motion_{identity}.png',
                     'sheet_width':image.width, 'sheet_height':image.height,
                     'native_scale':scale}
            frames.append(frame)
            diagnostics.append({'pose':POSES[row_index], 'direction':DIRECTIONS[col], 'visible_bounds':bounds,
                                'foot_method':foot_method, 'gutter_trim_pixels':gutter_trim_pixels, 'gutter_trim_fraction':round(gutter_trim_pixels/size, 8), 'skin_candidates':[[round(a,2),round(b,2),n] for a,b,n in candidates]})
        result.append(frames)
    assert path.read_bytes() == original, f'{path}: source PNG changed during measurement'
    data = {'sheet_width':image.width, 'sheet_height':image.height, 'native_scale':scale,
            'source_sha256':hashlib.sha256(original).hexdigest(),
            'alpha_zero_fraction':round(float((alpha==0).mean()), 7),
            'scale_reference':{'target_standing_height':52, 'source_mean_standing_passing_height':round(float(np.mean(reference_heights)), 3), 'shared_by_all_15_poses':True},
            'pose_names':POSES, 'rows':result}
    return data, diagnostics


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-missing', action='store_true')
    parser.add_argument('--only', nargs='+', type=int, choices=range(1,9), help='Inspect a partial batch; default measures all eight identities')
    parser.add_argument('--diagnostics', type=Path)
    args = parser.parse_args()
    data, diagnostics = {}, {}
    for number in args.only or range(1, 9):
        identity = f'wanderer_{number}'
        if not (ROOT / f'motion-{identity}.png').exists():
            assert args.allow_missing, f'Missing motion-{identity}.png'
            continue
        data[identity], diagnostics[identity] = measure(identity)
    (ROOT/'motion-geometry.json').write_text(json.dumps(data, ensure_ascii=False, indent=2)+'\n', encoding='utf8')
    if args.diagnostics: args.diagnostics.write_text(json.dumps(diagnostics, ensure_ascii=False, indent=2)+'\n', encoding='utf8')
    print(json.dumps({k:{'frames':15, 'scale':v['native_scale'], 'source_sha256':v['source_sha256']} for k,v in data.items()}, indent=2))


if __name__ == '__main__':
    main()
