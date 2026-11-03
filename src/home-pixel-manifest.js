// Measured source rectangles in the untouched image_gen PNG originals.
// Display dimensions are room pixels, independent from saved grid footprints.
const root = '/pixel-home/v028/';
const sheets = {
  chair: [[181,82,265,478],[815,82,250,478],[183,709,262,479],[816,708,250,480]],
  table: [[53,173,540,364],[775,153,334,384],[53,773,540,364],[775,753,334,384]],
  bed: [[155,83,316,486],[665,163,512,378],[154,758,319,371],[660,748,519,381]],
  bookshelf: [[143,71,365,479],[848,71,191,477],[143,697,367,480],[848,697,191,480]],
  display_shelf: [[76,164,475,373],[829,164,223,373],[77,792,475,372],[829,791,223,373]],
};
const round = value => Math.round(value * 1000) / 1000;
const variant = (kind, index, scale, facing, extras = () => ({})) => {
  const [x,y,w,h] = sheets[kind][index], width = round(w * scale), height = round(h * scale);
  return { src: `${root}${kind}.png`, sheet: { width: 1254, height: 1254 }, sourceRect: { x,y,w,h }, width,height, anchor: { x: width / 2, y: height - 1 }, facing, ...extras(width,height) };
};
const make = (kind, scale, extra = () => ({})) => ({ variants: Object.fromEntries([0,90,180,270].map((rotation,i) => [rotation,variant(kind,[0,3,2,1][i],scale,['south','west','north','east'][i],(w,h) => extra(rotation,w,h))])) });

export const HOME_PIXEL_ART = {
  chair: make('chair', .142, (rotation,w,h) => ({
    seat: { x: w * (rotation === 90 ? .4 : rotation === 270 ? .6 : .5), y: h * .57 },
    foreground: rotation === 180
      ? { rects: [[0,0,w,h*.76]] }
      : { rects: [[0,h*.66,w,h*.105]] },
  })),
  table: make('table', .178, (_rotation,w,h) => ({ surface: { x:w*.08,y:h*.12,width:w*.84,height:h*.32 } })),
  bed: make('bed', .205, (rotation,w,h) => ({
    seat: { x:w*(rotation===90?.46:rotation===270?.54:.5),y:h*(rotation===0?.51:rotation===180?.43:.58) },
    foreground: rotation===0 ? { rects:[[0,h*.43,w,h*.52]] }
      : rotation===180 ? { rects:[[0,h*.16,w,h*.8]] }
      : rotation===90 ? { rects:[[0,h*.42,w*.73,h*.48]] }
      : { rects:[[w*.27,h*.42,w*.73,h*.48]] },
  })),
  bookshelf: make('bookshelf', .208),
  display_shelf: make('display_shelf', .198),
  rug: { variants: Object.fromEntries([0,90,180,270].map(rotation => {
    const upright = rotation===90 || rotation===270;
    const width=upright?30.123:96, height=upright?84:34.4265;
    return [rotation,{ src:`${root}rug.png`,sheet:{width:1586,height:992},sourceRect:{x:160,y:277,w:1266,h:454},width,height,anchor:{x:width/2,y:height},planeRotation:upright?90:0,facing:'south' }];
  })) },
};

export const HOME_ROOM_ART = { src:`${root}room.png`,width:1366,height:1152 };
export const HOME_COTTAGE_ART = { src:`${root}cottage.png`,width:1536,height:1024,sourceRect:{x:284,y:157,w:968,h:782} };
