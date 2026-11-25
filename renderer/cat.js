/*
 * The cat, drawn in the full-screen overlay window. All positions are in overlay
 * pixels; `baseY` is the line its feet stand on (the bottom of the tab strip).
 *
 *   Cat.peek({ baseY, text })           trot in from the left screen edge and wait with a countdown
 *   Cat.pounce({ tabX, baseY, text })   gallop to the tab, skid, wiggle, pounce on it, celebrate, trot off
 *   Cat.hide()                          remove the cat
 *
 * The app is told 'impact' the moment the cat lands (close the tab now) and
 * 'done' when the cat has left the screen.
 */
const Cat = (() => {
  const bridge = window.pounce || null; // absent when this page is opened in a normal browser
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const C = {
    fur: '#f6a94f',
    far: '#e2903a', // legs on the far side of the body
    stripe: '#d97f2b',
    cream: '#fff0db',
    pink: '#f9b9a8',
    nose: '#e8798a',
    ink: '#2a1f17',
  };

  // The cat is drawn in a 240x200 box facing right, feet on y=190.
  const SCALE = 0.4;
  const W = 240 * SCALE;
  const H = 200 * SCALE;
  const FEET = 190 * SCALE;
  const HEAD_X = 172 * SCALE; // centre of the head, from the cat's left edge
  const PAWS_X = 136 * SCALE; // front paws
  const LEG = 52 * SCALE; // hip to ground
  const OFFSCREEN = -W - 20;
  const PEEK_X = -W * 0.46; // head, chest and front paws poke in
  const HOP = 48; // px the pounce covers
  const SKID = 20; // px the cat slides when it brakes

  // Two gaits. `stance` is the share of the cycle a foot spends on the ground.
  const TROT = { swing: 26, lift: 10, stance: 0.5, phase: { nearFront: 0, farBack: 0.06, farFront: 0.5, nearBack: 0.56 } };
  const GALLOP = { swing: 36, lift: 16, stance: 0.34, phase: { nearFront: 0, farFront: 0.1, nearBack: 0.5, farBack: 0.6 } };
  const TROT_SPEED = 0.16; // px per ms
  const DASH_SPEED = 0.36;
  const strideOf = (gait) => 2 * LEG * Math.sin((gait.swing * Math.PI) / 180); // px a planted foot covers

  const SPRING = 'cubic-bezier(.3, 1.6, .5, 1)'; // overshoots, then settles

  const stage = document.getElementById('stage');
  let ui = null;
  let catX = OFFSCREEN;
  let cycle = []; // looping run animations
  let idle = []; // looping animations while the cat waits
  let entering = null; // the trot into the peek position
  let busy = false;

  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function svg(tag, attrs = {}, kids = []) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    node.append(...kids);
    return node;
  }

  function div(className, kids = []) {
    const node = document.createElement('div');
    node.className = className;
    node.append(...kids);
    return node;
  }

  function anim(node, frames, options) {
    const animation = node.animate(frames, {
      fill: 'forwards',
      ...options,
      duration: options.duration * (reducedMotion() ? 0.01 : 1),
    });
    return animation.finished.catch(() => {});
  }

  // Ease a part from wherever it is now into a new pose.
  function pose(node, to, duration = 160, easing = 'ease-out') {
    return anim(node, [{ transform: getComputedStyle(node).transform }, { transform: to }], { duration, easing });
  }

  function loop(node, frames, options) {
    return node.animate(frames, { iterations: Infinity, ...options });
  }

  function stopLoops(list) {
    for (const animation of list) {
      const node = animation.effect.target;
      const from = getComputedStyle(node).transform;
      animation.cancel();
      // Settle from wherever the part was instead of snapping.
      node.animate([{ transform: from }, { transform: 'none' }], { duration: 120, easing: 'ease-out' });
    }
    list.length = 0;
  }

  /* ---- drawing ---- */

  const stroke = (color, width) => ({ stroke: color, 'stroke-width': width, 'stroke-linecap': 'round', fill: 'none' });
  const blob = (cx, cy, r, fill) => svg('circle', { cx, cy, r, fill });
  // A triangle with rounded corners: the stroke in the same colour rounds it off.
  const tuft = (points, fill) =>
    svg('polygon', { points, fill, stroke: fill, 'stroke-width': 7, 'stroke-linejoin': 'round' });

  function pivot(node, x, y) {
    node.style.transformOrigin = `${x}px ${y}px`;
    return node;
  }

  function leg(hipX, hipY, color) {
    return pivot(
      svg('g', {}, [
        svg('rect', { x: hipX - 10, y: hipY - 8, width: 20, height: 54, rx: 10, fill: color }),
        svg('ellipse', { cx: hipX + 3, cy: hipY + 45, rx: 13, ry: 8, fill: C.cream }),
      ]),
      hipX,
      hipY
    );
  }

  function drawCat() {
    // Fluff is overlapping circles in one flat colour: they merge into a scalloped outline.
    const tail = pivot(
      svg('g', {}, [
        blob(52, 114, 13, C.fur),
        blob(42, 100, 15, C.fur),
        blob(34, 84, 17, C.fur),
        blob(31, 66, 18, C.fur),
        blob(35, 49, 17, C.fur),
        blob(44, 36, 14, C.cream),
        blob(52, 27, 10, C.cream),
      ]),
      54,
      116
    );
    const tailWrap = pivot(svg('g', {}, [tail]), 54, 116); // tail sways inside; this streams it back in a dash

    const body = svg('g', {}, [
      svg('ellipse', { cx: 100, cy: 120, rx: 54, ry: 34, fill: C.fur }),
      blob(58, 116, 27, C.fur),
      blob(140, 118, 29, C.fur),
      blob(84, 149, 10, C.fur),
      blob(100, 152, 10, C.fur),
      blob(116, 150, 10, C.fur),
      svg('path', { d: 'M74 89 q5 10 0 19 M91 86 q5 10 0 19 M108 87 q5 10 0 19', ...stroke(C.stripe, 5) }),
    ]);

    const earL = pivot(svg('g', {}, [tuft('142,64 147,26 168,48', C.fur), tuft('149,56 151,38 162,50', C.pink)]), 156, 62);
    const earR = pivot(svg('g', {}, [tuft('176,48 198,26 202,64', C.fur), tuft('182,50 194,38 195,56', C.pink)]), 190, 62);
    const blink = pivot(
      svg('g', {}, [
        svg('ellipse', { cx: 158, cy: 84, rx: 7.5, ry: 9.5, fill: C.ink }),
        svg('ellipse', { cx: 192, cy: 84, rx: 7.5, ry: 9.5, fill: C.ink }),
        blob(160.5, 80.5, 3, '#fff'),
        blob(194.5, 80.5, 3, '#fff'),
      ]),
      175,
      84
    );
    const eyesOpen = svg('g', {}, [blink]);
    const eyesHappy = svg('path', { d: 'M150 87 q8 -10 16 0 M184 87 q8 -10 16 0', ...stroke(C.ink, 3.6) });
    const brows = svg('path', { d: 'M147 70 L166 77 M203 70 L184 77', ...stroke(C.ink, 4.2) });
    eyesHappy.style.opacity = 0;
    brows.style.opacity = 0;

    const head = pivot(
      svg('g', {}, [
        earL,
        earR,
        svg('ellipse', { cx: 172, cy: 84, rx: 43, ry: 37, fill: C.fur }),
        tuft('133,86 121,103 141,107', C.fur),
        tuft('136,98 128,114 148,112', C.fur),
        tuft('211,86 223,103 203,107', C.fur),
        tuft('208,98 216,114 196,112', C.fur),
        svg('path', { d: 'M172 50 v10 M161 52 l2 9 M183 52 l-2 9', ...stroke(C.stripe, 4.5) }),
        svg('ellipse', { cx: 175, cy: 101, rx: 18, ry: 12, fill: C.cream }),
        blob(147, 99, 7, C.pink),
        blob(203, 99, 7, C.pink),
        eyesOpen,
        eyesHappy,
        brows,
        svg('polygon', { points: '171,93 180,93 175.5,98', fill: C.nose }),
        svg('path', { d: 'M175.5 98 q-4 7 -10 2 M175.5 98 q4 7 10 2', ...stroke(C.ink, 2.6) }),
      ]),
      150,
      112
    );

    // Haunch, shoulder and chest fluff sit over the tops of the near legs.
    const front = svg('g', {}, [
      blob(62, 130, 21, C.fur),
      blob(130, 130, 17, C.fur),
      blob(150, 132, 14, C.cream),
      blob(143, 146, 11, C.cream),
      head,
    ]);

    const legs = {
      farBack: leg(80, 136, C.far),
      farFront: leg(142, 138, C.far),
      nearBack: leg(64, 138, C.fur),
      nearFront: leg(126, 140, C.fur),
    };
    const art = svg('svg', { viewBox: '0 0 240 200', 'aria-hidden': 'true' }, [
      tailWrap,
      legs.farBack,
      legs.farFront,
      body,
      legs.nearBack,
      legs.nearFront,
      front,
    ]);
    return { art, legs, tail, tailWrap, head, earL, earR, blink, eyesOpen, eyesHappy, brows, bobbers: [tailWrap, body, front] };
  }

  function build() {
    const rig = drawCat();
    // .cat travels, .flip turns around, .lean pitches and bounds, .jump hops and squashes.
    const jump = div('jump', [rig.art]);
    const lean = div('lean', [jump]);
    const flip = div('flip', [lean]);
    const cat = div('cat', [flip]);
    cat.style.width = W + 'px';
    cat.style.height = H + 'px';
    cat.style.transform = `translateX(${OFFSCREEN}px)`;
    const bubble = div('bubble');
    stage.append(cat, bubble);

    rig.blink.animate(
      [
        { transform: 'scaleY(1)', offset: 0 },
        { transform: 'scaleY(1)', offset: 0.93 },
        { transform: 'scaleY(0.08)', offset: 0.965 },
        { transform: 'scaleY(1)', offset: 1 },
      ],
      { duration: 3400, iterations: Infinity }
    );
    const tailSway = rig.tail.animate(
      [{ transform: 'rotate(-7deg)' }, { transform: 'rotate(9deg)' }],
      { duration: 800, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' }
    );

    ui = { ...rig, cat, flip, lean, jump, bubble, tailSway };
    catX = OFFSCREEN;
  }

  const place = (baseY) => {
    ui.cat.style.top = baseY - FEET + 'px';
  };

  /* ---- gaits ---- */

  function legFrames({ swing, lift, stance }) {
    // Planted and sweeping back, then lifted and swung forward.
    return [
      { transform: `translateY(0px) rotate(${-swing}deg)`, offset: 0 },
      { transform: `translateY(0px) rotate(${swing}deg)`, offset: stance },
      { transform: `translateY(${-lift}px) rotate(${swing * 0.2}deg)`, offset: stance + (1 - stance) * 0.5 },
      { transform: `translateY(0px) rotate(${-swing}deg)`, offset: 1 },
    ];
  }

  function startRun(gait, cycleMs) {
    stopLoops(cycle);
    stopLoops(idle);
    if (reducedMotion()) return;
    const frames = legFrames(gait);
    for (const [name, start] of Object.entries(gait.phase)) {
      cycle.push(loop(ui.legs[name], frames, { duration: cycleMs, iterationStart: start }));
    }

    if (gait === GALLOP) {
      // The whole body bounds: gather over the back feet, then stretch out through the air.
      cycle.push(
        loop(
          ui.lean,
          [
            { transform: 'translateY(0px) rotate(5deg) scale(1.05, .93)', offset: 0, easing: 'ease-out' },
            { transform: 'translateY(-9px) rotate(-5deg) scale(1.1, .93)', offset: 0.45, easing: 'ease-in' },
            { transform: 'translateY(-3px) rotate(2deg) scale(.97, 1.04)', offset: 0.8 },
            { transform: 'translateY(0px) rotate(5deg) scale(1.05, .93)', offset: 1 },
          ],
          { duration: cycleMs }
        )
      );
      // Tail streams out behind and ears flatten.
      cycle.push(
        loop(ui.tailWrap, [{ transform: 'rotate(-48deg)' }, { transform: 'rotate(-60deg)' }], {
          duration: cycleMs / 2,
          direction: 'alternate',
          easing: 'ease-in-out',
        })
      );
      cycle.push(loop(ui.earL, [{ transform: 'rotate(-20deg)' }, { transform: 'rotate(-14deg)' }], { duration: cycleMs / 2, direction: 'alternate' }));
      cycle.push(loop(ui.earR, [{ transform: 'rotate(-20deg)' }, { transform: 'rotate(-14deg)' }], { duration: cycleMs / 2, direction: 'alternate' }));
      cycle.push(loop(ui.head, [{ transform: 'rotate(7deg)' }, { transform: 'rotate(2deg)' }], { duration: cycleMs / 2, direction: 'alternate', easing: 'ease-in-out' }));
    } else {
      const bob = [{ transform: 'translateY(0px)' }, { transform: 'translateY(-5px)' }, { transform: 'translateY(0px)' }];
      for (const part of ui.bobbers) cycle.push(loop(part, bob, { duration: cycleMs / 2, easing: 'ease-in-out' }));
      cycle.push(loop(ui.head, [{ transform: 'rotate(-3deg)' }, { transform: 'rotate(4deg)' }], { duration: cycleMs / 2, direction: 'alternate', easing: 'ease-in-out' }));
    }
  }

  async function runTo(x, gait, pxPerMs) {
    const distance = Math.abs(x - catX);
    if (distance < 2) return;
    // Long trips get faster rather than longer.
    const duration = clamp(distance / pxPerMs, 220, 2600);
    const speed = distance / duration;
    // Cycle length follows ground speed so planted feet don't slide.
    const cycleMs = clamp(strideOf(gait) / gait.stance / speed, 170, 520);
    startRun(gait, cycleMs);
    const from = catX;
    catX = x;
    await anim(ui.cat, [{ transform: `translateX(${from}px)` }, { transform: `translateX(${x}px)` }], {
      duration,
      easing: 'linear',
    });
  }

  /* ---- little effects ---- */

  function say(text, left, top) {
    ui.bubble.style.left = clamp(left, 6, Math.max(6, window.innerWidth - 232)) + 'px';
    ui.bubble.style.top = top + 'px';
    if (ui.bubble.textContent === text) return;
    const wasEmpty = !ui.bubble.textContent;
    ui.bubble.textContent = text;
    if (wasEmpty) {
      anim(
        ui.bubble,
        [
          { opacity: 0, transform: 'translateY(-6px) scale(.6)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 320, easing: SPRING }
      );
    }
  }

  function hush() {
    if (!ui.bubble.textContent) return;
    ui.bubble.textContent = '';
    anim(ui.bubble, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.8)' }], { duration: 120, easing: 'ease-in' });
  }

  // A throwaway element that plays one animation and removes itself.
  function fx(className, x, y, frames, options, text) {
    const node = div(className);
    if (text) node.textContent = text;
    node.style.left = x + 'px';
    node.style.top = y + 'px';
    stage.append(node);
    return anim(node, frames, options).then(() => node.remove());
  }

  // Puffs of dust thrown between two angles (radians, 0 = right, negative = up).
  function dust(x, y, { count = 6, from, to, reach = 22, size = 1 }) {
    for (let i = 0; i < count; i++) {
      const angle = from + ((to - from) * i) / Math.max(1, count - 1);
      const far = reach * (0.7 + (i % 3) * 0.25);
      fx(
        'puff',
        x,
        y,
        [
          { opacity: 0.9, transform: `translate(0, 0) scale(${0.5 * size})` },
          { opacity: 0, transform: `translate(${Math.cos(angle) * far}px, ${Math.sin(angle) * far}px) scale(${1.7 * size})` },
        ],
        { duration: 380 + i * 25, easing: 'ease-out' }
      );
    }
  }

  function impact(x, y) {
    dust(x, y, { count: 9, from: -Math.PI * 0.95, to: -Math.PI * 0.05, reach: 34, size: 1.15 });
    fx('ring', x, y, [{ opacity: 0.9, transform: 'scale(.3)' }, { opacity: 0, transform: 'scale(3.2)' }], {
      duration: 420,
      easing: 'ease-out',
    });
    for (let i = 0; i < 7; i++) {
      const deg = -80 + i * 27; // a fan of streaks over the top
      fx(
        'spark',
        x,
        y,
        [
          { opacity: 1, transform: `rotate(${deg}deg) translateY(-12px) scaleY(.4)` },
          { opacity: 0, transform: `rotate(${deg}deg) translateY(-40px) scaleY(1.5)` },
        ],
        { duration: 340, easing: 'ease-out' }
      );
    }
    // The tab itself, batted away.
    fx(
      'chip',
      x + 14,
      y - 8,
      [
        { opacity: 0.95, transform: 'translate(-50%, -50%) rotate(0deg) scale(1)', offset: 0, easing: 'ease-out' },
        { opacity: 0.9, transform: 'translate(40%, -330%) rotate(140deg) scale(.8)', offset: 0.55, easing: 'ease-in' },
        { opacity: 0, transform: 'translate(120%, -120%) rotate(260deg) scale(.5)', offset: 1 },
      ],
      { duration: 700 }
    );
  }

  /* ---- public ---- */

  // Keep the whole cat on screen when the tabs sit right at the top (full screen).
  const onScreen = (baseY) => Math.max(baseY, FEET + 2);

  function peek({ baseY, text }) {
    if (busy) return;
    baseY = onScreen(baseY);
    if (!ui) build();
    place(baseY);
    if (!entering) {
      entering = runTo(PEEK_X, TROT, TROT_SPEED).then(() => {
        if (!ui || busy) return;
        stopLoops(cycle);
        // Waiting: curious head tilts and the odd ear flick.
        idle.push(
          loop(ui.head, [{ transform: 'rotate(-5deg)' }, { transform: 'rotate(6deg)' }], {
            duration: 2200,
            direction: 'alternate',
            easing: 'ease-in-out',
          })
        );
        idle.push(
          loop(
            ui.earR,
            [
              { transform: 'rotate(0deg)', offset: 0 },
              { transform: 'rotate(0deg)', offset: 0.86 },
              { transform: 'rotate(16deg)', offset: 0.9 },
              { transform: 'rotate(-4deg)', offset: 0.95 },
              { transform: 'rotate(0deg)', offset: 1 },
            ],
            { duration: 2900 }
          )
        );
      });
    }
    entering.then(() => {
      if (ui && !busy) say(text, PEEK_X + W + 4, baseY - H * 0.62);
    });
  }

  async function pounce({ tabX, baseY, text }) {
    if (busy) return;
    busy = true;
    baseY = onScreen(baseY);
    if (!ui) build();
    place(baseY);
    await entering;
    hush();
    const { legs } = ui;
    const landX = Math.max(HOP + SKID + 4, tabX - HEAD_X); // head ends up over the middle of the tab
    const stopX = landX - HOP;

    // 1. Dash along the tab strip.
    await runTo(Math.max(catX, stopX - SKID), GALLOP, DASH_SPEED);

    // 2. Brake: legs braced, body rocked back, sliding the last stretch in a cloud of dust.
    stopLoops(cycle);
    pose(legs.nearFront, 'rotate(-30deg)', 90);
    pose(legs.farFront, 'rotate(-24deg)', 90);
    pose(legs.nearBack, 'rotate(-22deg)', 90);
    pose(legs.farBack, 'rotate(-16deg)', 90);
    pose(ui.lean, 'rotate(-10deg) scale(.96, 1.04)', 110);
    pose(ui.tailWrap, 'rotate(24deg)', 200, SPRING); // tail whips forward
    dust(catX + PAWS_X, baseY - 3, { count: 5, from: -Math.PI * 0.9, to: -Math.PI * 0.6, reach: 20 });
    const slideFrom = catX;
    catX = stopX;
    await anim(ui.cat, [{ transform: `translateX(${slideFrom}px)` }, { transform: `translateX(${stopX}px)` }], {
      duration: 280,
      easing: 'cubic-bezier(.1, .7, .3, 1)',
    });
    for (const part of [...Object.values(legs), ui.tailWrap]) pose(part, 'none', 220, SPRING);
    await pose(ui.lean, 'none', 260, SPRING);

    // 3. Spot the tab.
    pose(ui.earL, 'rotate(-6deg) scale(1, 1.16)', 160, SPRING);
    pose(ui.earR, 'rotate(6deg) scale(1, 1.16)', 160, SPRING);
    fx(
      'alert',
      stopX + HEAD_X + 8,
      baseY - H - 2,
      [
        { opacity: 0, transform: 'translateY(8px) scale(.2)', offset: 0, easing: SPRING },
        { opacity: 1, transform: 'translateY(0) scale(1)', offset: 0.3 },
        { opacity: 1, transform: 'translateY(0) scale(1)', offset: 0.8 },
        { opacity: 0, transform: 'translateY(-6px) scale(.8)', offset: 1 },
      ],
      { duration: 800 },
      '!'
    );
    await wait(520);
    anim(ui.brows, [{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: 'ease-out' });
    pose(ui.head, 'rotate(5deg)', 200); // lowers its head: stalking
    say(text, stopX + W * 0.25, baseY + 8);
    await wait(1100);

    // 4. Play bow, then the wiggle, getting faster.
    const crouch = 'translateY(5px) rotate(6deg) scale(1.09, .83)';
    ui.tailSway.playbackRate = 3.5;
    pose(ui.earL, 'rotate(-18deg)', 160);
    pose(ui.earR, 'rotate(-18deg)', 160);
    await pose(ui.jump, crouch, 200);
    const beats = [0, 0.2, 0.37, 0.52, 0.65, 0.76, 0.85, 0.93, 1];
    await anim(
      ui.jump,
      beats.map((offset, i) => {
        const side = i === 0 || i === beats.length - 1 ? 0 : i % 2 ? 1 : -1;
        return { transform: `${crouch} translateX(${side * 2}px) skewX(${side * 9}deg)`, offset };
      }),
      { duration: 760, easing: 'linear' }
    );

    // 5. Pounce: stretch out on the way up, tuck and tip forward on the way down.
    hush();
    pose(legs.nearFront, 'rotate(-62deg)', 110);
    pose(legs.farFront, 'rotate(-50deg)', 110);
    pose(legs.nearBack, 'rotate(54deg)', 110);
    pose(legs.farBack, 'rotate(42deg)', 110);
    pose(ui.tailWrap, 'rotate(-40deg)', 160);
    anim(ui.cat, [{ transform: `translateX(${stopX}px)` }, { transform: `translateX(${landX}px)` }], {
      duration: 360,
      easing: 'linear',
    });
    catX = landX;
    setTimeout(() => {
      if (!ui) return;
      pose(legs.nearFront, 'rotate(-18deg)', 120);
      pose(legs.farFront, 'rotate(-10deg)', 120);
      pose(legs.nearBack, 'rotate(14deg)', 120);
      pose(legs.farBack, 'rotate(6deg)', 120);
    }, 230);
    await anim(
      ui.jump,
      [
        { transform: crouch, offset: 0, easing: 'ease-out' },
        { transform: 'translateY(-14px) rotate(-16deg) scale(.9, 1.16)', offset: 0.2, easing: 'ease-out' },
        { transform: 'translateY(-46px) rotate(-4deg) scale(.95, 1.08)', offset: 0.55, easing: 'ease-in' },
        { transform: 'translateY(0px) rotate(14deg) scale(.98, 1.04)', offset: 1 },
      ],
      { duration: 360 }
    );

    // 6. Landed: the tab closes now.
    bridge?.send('impact');
    impact(tabX, baseY - 2);
    for (const part of [...Object.values(legs), ui.tailWrap, ui.head]) pose(part, 'none', 260, SPRING);
    await anim(
      ui.jump,
      [
        { transform: 'translateY(9px) rotate(6deg) scale(1.22, .7)', offset: 0, easing: 'ease-out' },
        { transform: 'translateY(-7px) rotate(-2deg) scale(.93, 1.1)', offset: 0.4, easing: 'ease-in-out' },
        { transform: 'translateY(2px) scale(1.04, .96)', offset: 0.72, easing: 'ease-in-out' },
        { transform: 'none', offset: 1 },
      ],
      { duration: 460 }
    );

    // 7. Very pleased with itself.
    ui.tailSway.playbackRate = 1.6;
    ui.brows.style.opacity = 0;
    anim(ui.brows, [{ opacity: 1 }, { opacity: 0 }], { duration: 80 });
    ui.eyesOpen.style.opacity = 0;
    ui.eyesHappy.style.opacity = 1;
    pose(ui.earL, 'none', 200, SPRING);
    pose(ui.earR, 'none', 200, SPRING);
    pose(ui.head, 'rotate(-7deg)', 220, SPRING);
    fx(
      'heart',
      landX + HEAD_X + 12,
      baseY - H + 4,
      [
        { opacity: 0, transform: 'translateY(6px) scale(.3)', offset: 0, easing: SPRING },
        { opacity: 1, transform: 'translateY(-4px) scale(1)', offset: 0.3 },
        { opacity: 0, transform: 'translateY(-26px) scale(1.1)', offset: 1 },
      ],
      { duration: 1100 },
      '♥'
    );
    const hopUp = [
      { transform: 'none', offset: 0, easing: 'ease-out' },
      { transform: 'translateY(-9px) scale(.96, 1.06)', offset: 0.45, easing: 'ease-in' },
      { transform: 'translateY(0px) scale(1.06, .93)', offset: 0.85 },
      { transform: 'none', offset: 1 },
    ];
    await anim(ui.jump, hopUp, { duration: 260 });
    await anim(ui.jump, hopUp, { duration: 260 });
    await wait(520);

    // 8. Spin around with a hop and trot off the way it came, tail up.
    ui.eyesOpen.style.opacity = 1;
    ui.eyesHappy.style.opacity = 0;
    pose(ui.head, 'none', 160);
    anim(ui.jump, hopUp, { duration: 240 });
    await anim(ui.flip, [{ transform: 'scaleX(1)' }, { transform: 'scaleX(-1)' }], { duration: 200, easing: 'ease-in-out' });
    pose(ui.tailWrap, 'rotate(14deg)', 200);
    await runTo(OFFSCREEN, TROT, TROT_SPEED * 1.7);
    hide();
    bridge?.send('done');
  }

  function hide() {
    stage.replaceChildren();
    ui = null;
    entering = null;
    busy = false;
    cycle = [];
    idle = [];
    catX = OFFSCREEN;
  }

  if (bridge) {
    bridge.on('peek', peek);
    bridge.on('pounce', pounce);
    bridge.on('hide', hide);
  } else {
    document.body.classList.add('demo');
  }

  return { peek, pounce, hide };
})();
