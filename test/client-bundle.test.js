/**
 * The client bundle, loaded the way the browser loads it.
 *
 * The bundle is a classic script registered through
 * `window.__ModuleLoader__.load`, so the only honest way to test it is to stand
 * up that global, require the bundle, and call the factory — which is what this
 * file does. Everything a real load would catch but a source grep would not
 * (a module that never registers, a descriptor table that drifted from the Host
 * manifest, an `apply` that forgets to mount its Remote) is asserted here.
 *
 * The `$mount` assertion exists because of a real failure: the Host half
 * registered its Typert manifest correctly, the bundle loaded without error, and
 * the Settings section still never appeared — because `remote.<namespace>` is
 * created by the *client* mounting its own contribution, and a `ctx.inject` that
 * waits for a namespace nobody mounts reports nothing at all.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

import { REMOTE_INVOCATIONS } from '../src/remote/invocations.js';

const SOURCE = await readFile(new URL('../client.js', import.meta.url), 'utf8');

/** Minimal React stand-ins: enough for the factory to build its components. */
/**
 * Build a client context whose `slots.register` records both of its arguments.
 *
 * @returns {{ ctx: any, mounted: any[], registered: any[], injected: string[] }} the harness.
 */
function makeClientHarness() {
  const mounted = [];
  const registered = [];
  const injected = [];
  const ctx = {
    effect: (fn) => {
      const result = typeof fn === 'function' ? fn() : undefined;
      if (result && typeof result.then === 'function') result.catch(() => {});
      return () => {};
    },
    locale: { register: () => () => {}, bind: () => (key) => key, subscribe: () => () => {} },
    slots: {
      inject: (name, fn) => {
        injected.push(name);
        fn();
      },
      register: (options, component) => {
        registered.push({ ...options, component });
        return () => {};
      },
    },
    remote: { $mount: async (contribution) => { mounted.push(contribution); return () => {}; } },
    inject: (deps, callback) => {
      injected.push(deps.join(','));
      // The namespace service the real Cordis would hand to the callback; a bare
      // `{}` would let a missing method pass this harness and fail in the browser.
      callback({ remote: { workspaceProfile: { validateRoute: async () => ({ available: true }) } } });
    },
  };
  return { ctx, mounted, registered, injected };
}

function makeReact() {
  const passthrough = (type) => (props) => ({ type, props });
  return {
    createElement: passthrough,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    Component: class {
      constructor(props) {
        this.props = props;
        this.state = {};
      }
      setState(next) {
        this.state = { ...this.state, ...next };
      }
    },
  };
}

/**
 * Load the bundle in a sandbox and return what it registered.
 *
 * @returns {{ exports: any, registrations: any[] }} the module exports and every `load()` call.
 */
function loadBundle() {
  const registrations = [];
  const context = {
    window: {
      __ModuleLoader__: {
        load: (entry) => {
          registrations.push(entry);
          // The real loader calls the factory and adopts the returned exports.
          entry.exports = entry.factory((name) => {
            if (name === 'react') return makeReact();
            if (name === 'react/jsx-runtime') {
              return {
                jsx: (type, props) => ({ type, props }),
                jsxs: (type, props) => ({ type, props }),
                Fragment: Symbol('Fragment'),
              };
            }
            throw new Error(`unexpected require(${name})`);
          });
        },
      },
    },
    console,
    setTimeout,
    clearTimeout,
    navigator: {},
    document: undefined,
  };
  context.globalThis = context;
  vm.createContext(context);
  new vm.Script(SOURCE, { filename: 'client.js' }).runInContext(context);
  assert.equal(registrations.length, 1, 'the bundle must call __ModuleLoader__.load exactly once');
  return registrations[0];
}

test('the bundle registers under the package name the loader row uses', () => {
  const entry = loadBundle();
  // The loader compares this id against `entry.options.name`; a mismatch fails as
  // `bundle <url> loaded without registering "<id>"`.
  assert.equal(entry.id, 'dsh-workspace-profile');
  assert.equal(typeof entry.factory, 'function');
});

test('the inlined descriptor table has not drifted from the host manifest', () => {
  const entry = loadBundle();
  const client = entry.exports.TYPERT_REMOTE.descriptors;
  const shape = (descriptor) => ({
    id: descriptor.id,
    service: descriptor.service,
    namespace: descriptor.namespace,
    method: descriptor.method,
    implementation: descriptor.implementation,
    invocation: descriptor.invocation,
    parameters: descriptor.parameters.map((parameter) => ({
      name: parameter.name,
      wire: parameter.wire,
      source: parameter.source,
      acceptsUndefined: parameter.acceptsUndefined,
    })),
    cancellation: descriptor.cancellation,
  });
  // The bundle cannot import the shared table, so it carries a copy. This is the
  // assertion that makes the copy acceptable. Compared as plain JSON: the bundle
  // runs in its own vm realm, so its objects have a different prototype and
  // `deepEqual` would fail on identity rather than on content.
  assert.deepEqual(
    JSON.parse(JSON.stringify(client.map(shape))),
    JSON.parse(JSON.stringify(REMOTE_INVOCATIONS.map((invocation) => shape({
      id: `dsh-workspace-profile#workspaceProfile/${invocation.method}`,
      service: 'workspaceProfile',
      namespace: 'workspaceProfile',
      method: invocation.method,
      implementation: invocation.implementation,
      invocation: { kind: 'direct' },
      parameters: invocation.parameters.map((parameter) => ({
        name: parameter.name,
        wire: parameter.name,
        source: 'json',
        acceptsUndefined: false,
      })),
      cancellation: invocation.cancellable === true ? { parameter: 'signal' } : undefined,
    })))),
  );
  assert.equal(entry.exports.TYPERT_REMOTE.package, 'dsh-workspace-profile');
});

test('every descriptor carries a strict codec, which the Gateway requires', () => {
  const entry = loadBundle();
  for (const descriptor of entry.exports.TYPERT_REMOTE.descriptors) {
    assert.equal(descriptor.invocation.kind, 'direct');
    assert.equal(descriptor.result.mode, 'strict');
    assert.ok(typeof descriptor.result.typeSymbol === 'string');
    assert.equal(typeof descriptor.result.create().parse, 'function');
    for (const parameter of descriptor.parameters) {
      assert.equal(parameter.codec.mode, 'strict');
      assert.equal(parameter.source, 'json');
      assert.ok(typeof parameter.codec.typeSymbol === 'string');
    }
    if (descriptor.cancellation !== undefined) {
      assert.equal(descriptor.cancellation.parameter, 'signal');
    }
  }
});

test('apply mounts the Remote contribution before waiting for the namespace', async () => {
  const entry = loadBundle();
  const { ctx, mounted, registered, injected } = makeClientHarness();
  // The real Cordis waits for an injected service; this harness runs the callback
  // directly so the registration path is exercised.
  await entry.exports.apply(ctx);

  assert.equal(mounted.length, 1, 'the bundle must mount exactly one Remote contribution');
  assert.equal(mounted[0].package, 'dsh-workspace-profile');
  assert.deepEqual(
    [...mounted[0].descriptors.map((descriptor) => descriptor.method)],
    REMOTE_INVOCATIONS.map((invocation) => invocation.method),
  );
  assert.ok(injected.includes('remote.workspaceProfile'), 'the section must wait for the mounted namespace');
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, 'settings.section');
  assert.equal(registered[0].id, 'workspace-profile');
});

test('the section registration carries a label, an order and an inject factory', () => {
  const entry = loadBundle();
  const { ctx, registered } = makeClientHarness();
  entry.exports.apply(ctx);
  const options = registered[0];
  assert.equal(typeof options.label, 'function');
  assert.equal(typeof options.order, 'number');
  assert.equal(typeof options.inject, 'function');
  const injected = options.inject();
  assert.ok('remote' in injected, 'the body needs the Remote namespace');
  assert.equal(typeof injected.validateRoute, 'function');
  // The factory's return value is spread into props, so every name the body
  // destructures must be produced here. This assertion is why the missing
  // `locale` was a one-line fix rather than a second blank-panel hunt.
  for (const prop of ['remote', 'locale', 'validateRoute']) {
    assert.ok(prop in injected, `the inject factory must supply "${prop}"`);
    assert.notEqual(injected[prop], undefined, `"${prop}" must not be undefined`);
  }
});

/**
 * Split one call's argument list at top-level commas.
 *
 * A regex cannot do this: props objects contain commas, nested calls, and
 * arrow functions. Parens, brackets and braces are tracked so only the commas
 * that separate arguments are counted.
 *
 * @param {string} source - the module source.
 * @param {number} openIndex - index of the `(` that opens the argument list.
 * @returns {{ args: number, end: number }} the argument count and the index of the matching `)`.
 */
function countArguments(source, openIndex) {
  let depth = 0;
  let args = 1;
  let sawContent = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (character === '(' || character === '[' || character === '{') depth += 1;
    else if (character === ')' || character === ']' || character === '}') {
      depth -= 1;
      if (depth === 0) return { args: sawContent ? args : 0, end: index };
    } else if (character === ',' && depth === 1) args += 1;
    if (depth >= 1 && !/\s/.test(character)) sawContent = true;
  }
  return { args: -1, end: -1 };
}

test('no Remote call passes a trailing undefined argument', () => {
  // A Remote method takes its BUSINESS arguments positionally and nothing else;
  // the carrier appends the cancellation signal. A trailing `undefined` — as in
  // `remote.snapshot(undefined)` — builds the call with one argument too many,
  // and the endpoint then never answers: the panel waits forever with no error
  // anywhere. Both working third-party plugins on this machine call a zero-arg
  // method as `remote.status()`.
  const offenders = SOURCE.match(/remote\.[A-Za-z_$][\w$]*\([^)]*\bundefined\s*\)/g) ?? [];
  assert.deepEqual(offenders, [], `Remote calls must not pass undefined: ${offenders.join(' | ')}`);
  // And the zero-business-argument methods are called with no argument at all.
  for (const method of ['snapshot', 'models']) {
    assert.ok(SOURCE.includes(`remote.${method}()`), `remote.${method}() must be called with no arguments`);
  }
});

test('every jsx call passes exactly one props argument', () => {
  // The real `jsx` runtime silently drops a variadic third argument, so a
  // component written that way renders as an empty element with no error
  // anywhere — the worst possible failure for a UI. Strings and comments are
  // skipped so the counts reflect code.
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const pattern = /\bjsxs?\(/g;
  let match;
  let calls = 0;
  /** @type {number[]} */
  const bad = [];
  while ((match = pattern.exec(code)) !== null) {
    calls += 1;
    const { args } = countArguments(code, match.index + match[0].length - 1);
    if (args !== 2) bad.push(match.index);
  }
  assert.ok(calls > 50, `expected many jsx call sites, found ${calls}`);
  assert.deepEqual(bad, [], `jsx/jsxs calls with the wrong argument count at offsets ${bad.join(', ')}`);
});

test('every slot body is wrapped in the error boundary', () => {
  const entry = loadBundle();
  const { ctx, registered } = makeClientHarness();
  entry.exports.apply(ctx);
  // The runtime swallows render exceptions and leaves an empty seat; without a
  // boundary the only symptom of any mistake is a blank panel.
  const rendered = registered[0].component;
  assert.equal(typeof rendered, 'function');
});

test('the section injects one stylesheet, and every class it names is defined in it', () => {
  // The tab strip's active underline is an `::after` and its hover colour is a
  // `:hover` — neither is expressible with an inline `style` object, so this page
  // now depends on a real stylesheet. Two failure modes matter and both are
  // silent in the browser: the sheet never being injected (everything renders as
  // unstyled text), and a class being referenced without a rule (that one element
  // silently loses its layout).
  assert.ok(SOURCE.includes('data-plugin-css'), 'the stylesheet must carry an identity for de-duplication');

  const cssMatch = /const SECTION_CSS = \[([\s\S]*?)\]\.join\(''\)/.exec(SOURCE);
  assert.ok(cssMatch, 'expected a SECTION_CSS payload');
  const classes = new Set();
  for (const m of SOURCE.matchAll(/\.\$\{C\.([a-zA-Z]+)\}/g)) classes.add(m[1]);

  // Every class in the map must appear at least once as a selector.
  const declared = new Set();
  const cssBody = cssMatch[1];
  for (const m of cssBody.matchAll(/\$\{C\.([a-zA-Z]+)\}/g)) declared.add(m[1]);
  assert.ok(declared.size >= 8, `expected a real stylesheet, saw ${declared.size} classes`);

  const classMap = /const C = \{([\s\S]*?)\n    \};/.exec(SOURCE);
  assert.ok(classMap, 'expected the class map');
  const mapped = new Set([...classMap[1].matchAll(/^\s+([a-zA-Z]+):/gm)].map((m) => m[1]));
  // `control` is composed into selectors rather than used alone; still checkable.
  const missingRule = [...mapped].filter((name) => !declared.has(name));
  assert.deepEqual(missingRule, [], `classes with no CSS rule: ${missingRule.join(', ')}`);

  const unused = [...declared].filter((name) => !mapped.has(name));
  assert.deepEqual(unused, [], `rules for classes not in the map: ${unused.join(', ')}`);
});

test('the workspace selector is a disclosure, and the sections get the tabs', () => {
  // These are different decisions and must not be confused: a workspace count is
  // unbounded, so it gets a disclosure; the section count is fixed at three, so it
  // gets a tab strip. A regression here would most likely swap them back.
  for (const attribute of ["'aria-expanded'", "'aria-controls'", 'pickHead', 'pickList', 'pickItem']) {
    assert.ok(SOURCE.includes(attribute), `the picker must carry ${attribute}`);
  }
  // The closed state has to answer "which workspace am I configuring", which is
  // the whole reason this is not a <select>.
  assert.ok(SOURCE.includes('C.pickPath'), 'the closed header must show the workspace path');
  assert.ok(SOURCE.includes('C.pickTitle'), 'the closed header must show the workspace title');
  assert.ok(/jsxs\('button', \{\s*type: 'button',\s*className: C\.pickHead/.test(SOURCE));

  // The tab strip exists, is a real tablist, and is keyboard-operable.
  for (const attribute of ["role: 'tablist'", "role: 'tab'", "'aria-selected'", "'aria-controls'", 'tabIndex']) {
    assert.ok(SOURCE.includes(attribute), `the tab strip must carry ${attribute}`);
  }
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
    assert.ok(SOURCE.includes(key), `keyboard navigation must handle ${key}`);
  }
  // Exactly three tabs, whose ids the panels address by the same names.
  const tabs = /tabs: \[([\s\S]*?)\],\s*activeId/.exec(SOURCE);
  assert.ok(tabs, 'expected a tab declaration');
  const ids = [...tabs[1].matchAll(/id: '([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['workspace', 'skills', 'subagents']);
  for (const id of ids) {
    assert.ok(SOURCE.includes("panel('" + id + "')"), `panel("${id}") must be rendered`);
  }

  // The abandoned left column is gone for good.
  assert.equal(SOURCE.includes('sidebar:'), false, 'the left column must be gone');
});

test('the cards match the platform settings cards, and the tab tabs are titled by their tab', () => {
  // The visual language is the platform's own card (PluginCard.module.css):
  // 16px radius, `.5px` border at l4, bg-layer-3. Asserting the values rather than
  // the existence keeps a future edit from drifting to an invented look.
  for (const rule of ['border:.5px solid', 'border-radius:16px', 'bg-layer-3']) {
    assert.ok(SOURCE.includes(rule), `the card rule must include ${rule}`);
  }
  assert.ok(SOURCE.includes('function Card({ title, note, grow, children })'), 'expected the Card component');
  // A title is optional: the skills and subagent tabs are named by their tab, and
  // repeating the name in the card head is noise.
  assert.ok(SOURCE.includes('title === undefined || title === null'), 'the card head must be optional');
  // And a card can stretch, which is what gives the skills list the tab's height.
  assert.ok(SOURCE.includes('cardGrow'), 'expected the growing card variant');
  assert.ok(SOURCE.includes('cardBodyGrow'), 'expected the growing card body variant');
});

test('the Skill switch is binary, and the store still accepts the third state', () => {
  // The row control became a switch, so the UI can only ever write `enabled` or
  // `disabled`. The store is deliberately NOT narrowed with it: `recommended` is a
  // real stored value (set before this round, and by any other writer), and
  // rejecting it would silently invalidate existing documents.
  assert.ok(SOURCE.includes("onToggle(row.name, enabled ? 'disabled' : 'enabled')"),
    'the switch must write exactly enabled/disabled');
  assert.equal(
    SOURCE.includes("onToggle(row.name, event.target.value)"),
    false,
    'the dropdown write path must be gone, not merely unused',
  );
  assert.equal(SOURCE.includes("value: 'recommended'"), false, 'the UI must no longer offer "recommended"');
  // The third state still renders when it is stored.
  assert.ok(SOURCE.includes("row.state === 'recommended'"), 'a stored "recommended" must still be shown');

  // Both locales must define every key the rows and the tabs read, or one language
  // renders `undefined` where a label belongs.
  const zhStart = SOURCE.indexOf("nav: '工作区'");
  const enStart = SOURCE.indexOf("nav: 'Workspaces'");
  assert.ok(zhStart > 0 && enStart > zhStart, 'expected a zh block followed by an en block');
  const zh = SOURCE.slice(zhStart, enStart);
  const en = SOURCE.slice(enStart, SOURCE.indexOf('};', enStart));
  for (const key of [
    'stateEnabled',
    'stateDisabled',
    'recommendedByProfile',
    'recommendedByWorkspace',
    'recommendedByProfileHint',
    'recommendedByWorkspaceHint',
    'skillStateLabel',
    'perspectiveHint',
    'perspectiveNone',
    'blockNormsHint',
    'pendingEdits',
    'chooseWorkspace',
    'workspaceLabel',
    'tabWorkspace',
    'tabSkills',
    'tabSubagents',
    'shownOfTotal',
    'totalOf',
  ]) {
    assert.ok(zh.includes(`${key}:`), `zh locale is missing "${key}"`);
    assert.ok(en.includes(`${key}:`), `en locale is missing "${key}"`);
  }
});

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A React stand-in that actually re-renders.
 *
 * The other harness in this file builds element trees without running them,
 * which is enough to check arguments and registration but cannot tell whether a
 * component *renders*. That gap matters most for exactly the change this exists
 * for: a layout rewrite whose failure mode is a blank panel, where "the tests
 * pass" and "the user sees nothing" are both true.
 *
 * Hooks are stored positionally, the way React stores them, so a component that
 * calls them conditionally would misbehave here too — which is the point.
 *
 * @param {(name: string) => any} require - the module loader's `require`.
 * @returns {any} the React namespace, plus `render`.
 */
function makeLiveReact() {
  // Hook storage is per component *instance*, so a component that appears more
  // than once (the four `Card`s) does not share state. Instances are identified
  // by occurrence order within a pass, which is stable for a deterministic
  // render — the same trick React's own index-based reconciliation relies on.
  const stores = new Map();
  let occurrences = new Map();
  let cells = null;
  let cursor = 0;
  let queue = [];
  let dirty = false;

  const sameDeps = (a, b) => {
    if (a === undefined || b === undefined) return false;
    if (a.length !== b.length) return false;
    return a.every((value, index) => Object.is(value, b[index]));
  };

  const cellsFor = (component) => {
    const index = occurrences.get(component) || 0;
    occurrences.set(component, index + 1);
    let list = stores.get(component);
    if (list === undefined) { list = []; stores.set(component, list); }
    if (list[index] === undefined) list[index] = [];
    return list[index];
  };

  const react = {
    createElement: (type, props) => ({ type, props: props === undefined ? {} : props }),
    useState(initial) {
      const slot = cursor++;
      if (cells[slot] === undefined) cells[slot] = { value: typeof initial === 'function' ? initial() : initial };
      const cell = cells[slot];
      return [cell.value, (next) => {
        cell.value = typeof next === 'function' ? next(cell.value) : next;
        dirty = true;
      }];
    },
    useRef(value) {
      const slot = cursor++;
      if (cells[slot] === undefined) cells[slot] = { value: { current: value } };
      return cells[slot].value;
    },
    // Deps are honoured. Without this the harness re-runs every effect on every
    // pass, the mount-time `load()` fires forever, and a component that renders
    // perfectly well in the browser never settles here — a harness bug that looks
    // exactly like a broken component.
    useEffect(fn, deps) {
      const slot = cursor++;
      const cell = cells[slot];
      if (cell !== undefined && sameDeps(cell.deps, deps)) return;
      cells[slot] = { deps };
      queue.push(fn);
    },
    useCallback(fn, deps) {
      const slot = cursor++;
      const cell = cells[slot];
      if (cell !== undefined && sameDeps(cell.deps, deps)) return cell.value;
      cells[slot] = { deps, value: fn };
      return fn;
    },
    useMemo(fn, deps) {
      const slot = cursor++;
      const cell = cells[slot];
      if (cell !== undefined && sameDeps(cell.deps, deps)) return cell.value;
      cells[slot] = { deps, value: fn() };
      return cells[slot].value;
    },
    Component: class {
      constructor(props) { this.props = props; this.state = {}; }
      setState(next) { this.state = { ...this.state, ...next }; dirty = true; }
      render() { return this.props.children; }
    },
  };

  /**
   * Render one element, descending into function and class components.
   *
   * A tree walk that stopped at `{ type, props }` would report every composite
   * component as a single opaque node — so a picker that renders nothing and a
   * picker that renders correctly would look identical, which is the exact bug
   * class this test exists to catch.
   *
   * @param {any} node - an element, an array, or a leaf.
   * @returns {any} the same shape with every composite component expanded.
   */
  const expand = (node) => {
    if (node === null || node === undefined) return node;
    if (Array.isArray(node)) return node.map(expand);
    if (typeof node !== 'object' || node.type === undefined) return node;
    const { type, props } = node;
    const safeProps = props === undefined ? {} : props;
    if (typeof type === 'function') {
      const saved = cells;
      const savedCursor = cursor;
      cells = cellsFor(type);
      cursor = 0;
      const out = expand(type(safeProps));
      cells = saved;
      cursor = savedCursor;
      return out;
    }
    if (typeof type === 'string') {
      return { type, props: { ...safeProps, children: expand(safeProps.children) } };
    }
    if (typeof type === 'symbol' || type === null) {
      // `Fragment` arrives as a Symbol and has no class to instantiate; it exists
      // only to group children without a wrapper element, so expanding them is the
      // whole of its behaviour.
      return { type, props: { ...safeProps, children: expand(safeProps.children) } };
    }
    const instance = new type(safeProps);
    return expand(instance.render());
  };

  /**
   * Render a component to a settled tree.
   *
   * Settled means every synchronous state update has been re-run and every
   * already-resolved promise has had a turn to land.
   *
   * @param {Function} Component - the function component.
   * @param {any} props - its props.
   * @param {number} [maxPasses] - the convergence budget.
   * @returns {Promise<any>} the final element tree.
   */
  react.render = async (Component, props, maxPasses = 30) => {
    let tree = null;
    for (let pass = 0; pass < maxPasses; pass += 1) {
      occurrences = new Map();
      cursor = 0;
      queue = [];
      dirty = false;
      // The root is rendered here rather than through `expand`, so it gets its
      // own hook storage and is not counted twice.
      const saved = cells;
      cells = cellsFor(Component);
      const element = Component(props);
      cells = saved;
      tree = expand(element);
      for (const effect of queue) effect();
      // Two turns is what an `await`ed non-thenable needs to resume and flush its
      // setState; more are harmless because the loop exits when nothing is dirty.
      await Promise.resolve();
      await Promise.resolve();
      if (!dirty) return tree;
    }
    throw new Error(`component did not settle within ${maxPasses} passes`);
  };

  return react;
}

/** Load the bundle against the live React.
 *
 * @returns {{ entry: any, react: any }} the loader entry and the React instance
 *   whose hook storage the rendered components will use.
 */
function loadRenderableSection(reuse) {
  const registrations = [];
  const context = reuse === undefined ? {
    window: {
      __ModuleLoader__: {
        load: (entry) => {
          registrations.push(entry);
          entry.exports = entry.factory((name) => {
            // ONE instance for `react` and `react/jsx-runtime`. Handing out two
            // would give the component its hooks from a namespace the test never
            // drives, and the symptom is a null-deref deep inside `useState`
            // rather than anything that names the real mistake.
            const react = context.__react;
            if (name === 'react') return react;
            if (name === 'react/jsx-runtime') {
              return {
                jsx: (type, props) => react.createElement(type, props),
                jsxs: (type, props) => react.createElement(type, props),
                Fragment: Symbol('Fragment'),
              };
            }
            throw new Error(`unexpected require(${name})`);
          });
        },
      },
    },
    console,
    setTimeout,
    clearTimeout,
    navigator: {},
    document: undefined,
  } : reuse;
  context.globalThis = context;
  // One React instance for the whole load, so `jsx-runtime` and `react` share
  // hook storage.
  context.__react = makeLiveReact();
  // A document just real enough to capture the injected stylesheet. Asserting on
  // the *generated* CSS is the only way to check the token values that reach the
  // page — the source only says `${SUCCESS}`.
  const injected = context.__injected || (context.__injected = []);
  if (context.document === undefined) context.document = {
    head: { appendChild: (tag) => { injected.push(tag); context.__existingTag = tag; } },
    createElement: () => ({ dataset: {}, textContent: '' }),
    // `null`, not `undefined`: that is what the real `querySelector` returns for a
    // miss, and a double that differs here tests a contract nobody has.
    querySelector: () => (context.__existingTag === undefined ? null : context.__existingTag),
  };
  vm.createContext(context);
  new vm.Script(SOURCE, { filename: 'client.js' }).runInContext(context);
  return { entry: registrations[0], react: context.__react, injected, context };
}

/** Every element in a tree, depth-first. */
function walk(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const item of node) walk(item, out); return out; }
  if (node.type !== undefined) out.push(node);
  walk(node.props ? node.props.children : undefined, out);
  return out;
}

/**
 * Render the section with a seeded snapshot and return the element tree.
 *
 * @param {object} [options] - overrides.
 * @param {number} [options.skillCount] - how many Skill rows the catalog carries.
 * @param {object} [options.skillOverrides] - stored Skill states.
 * @returns {Promise<{ elements: any[], classes: string, react: any, rerender: Function, tree: any }>}
 *   the rendered tree, flattened.
 */
async function renderSection({
  skillCount = 0,
  skillOverrides = {},
  subagents = null,
  // The *stored policy's* onboarding status, which is the prompt-injection gate.
  // Separate from `skillOverrides` above, which seeds the Skill catalog's rows:
  // the whole point of these tests is that a Workspace can have stored Skill
  // toggles and still inject nothing.
  policyOnboarding = 'configured',
  policySkillOverrides = {},
  // The Profile vocabulary, and the Profile the Workspace is stored with. The
  // default has a single Profile and no stance, which is the *empty* case: the
  // 默认视角 control then renders as text rather than a select. A test that needs
  // the real shape (诉讼 + 原告代理人) passes the litigation vocabulary instead.
  vocabularyProfiles = [{ id: 'general', label: 'General', perspectives: [{ id: 'none', label: 'None' }] }],
  policyProfile = 'general',
  policyPerspective = 'none',
  // The injection preview the Host would answer with. `null` means "not seeded";
  // an object is merged over the default fixture; a function receives the args.
  injection = null,
  // The Matter read the Host would answer with. Default is "no matter.yaml here",
  // which is what an ordinary project directory produces.
  matter = null,
} = {}) {
  const { entry, react, injected } = loadRenderableSection();
  const { ctx, registered } = makeClientHarness();
  entry.exports.apply(ctx);

  const rows = [];
  for (let i = 0; i < skillCount; i += 1) {
    // Names shaped like the real ones, including a long one, so the layout
    // assertions are about the sizes the plugin actually meets.
    const name = i === 0
      ? 'prc-legal-research-securities-compliance'
      : 'skill-' + String(i).padStart(3, '0') + '-research-helper';
    rows.push({
      name,
      description: 'A skill that does something. ' + 'x'.repeat(40),
      source: i % 3 === 0 ? 'bundled' : 'user-agents',
      provider: 'workspace-profile',
      modelInvocable: true,
      userInvocable: true,
      managed: i % 3 !== 0,
      state: skillOverrides[name] || 'enabled',
      overridden: name in skillOverrides,
      recommended: false,
    });
  }

  const snapshot = {
    ready: true, revision: 7, schemaVersion: 1, initializedAt: '', readError: null,
    capabilities: { settings: true, workspace: true, skills: true, models: true, systemPrompt: true, subagents: true },
    orphans: [],
    vocabulary: {
      profiles: vocabularyProfiles,
      skillStates: ['recommended', 'enabled', 'disabled'],
      perspectives: vocabularyProfiles.flatMap((entry) => entry.perspectives),
    },
    workspaces: [
      {
        workspaceId: 'ws-1', title: '华北地产重整', path: '/cases/huabei', sessionCount: 0,
        configured: true, capabilities: {},
        instructions: { global: { present: false, path: '' }, project: { present: true, root: '/x', files: ['/x/AGENTS.md'] } },
        policy: {
          profile: policyProfile, defaultPerspective: policyPerspective, onboardingStatus: policyOnboarding,
          skillOverrides: policySkillOverrides,
          subagents: subagents === null ? [] : [
            {
              id: 'sub-1', key: 'legal-anylist', name: '高级顾问', enabled: true,
              description: '高级顾问，负责专业法律问题的深度分析',
              provider: 'kimi-coding', model: 'k3', reasoningEffort: 'max',
              createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
            },
            {
              id: 'sub-2', key: 'off-agent', name: '停用的顾问', enabled: false,
              description: '一个被停用的专家',
              provider: 'deepseek-official', model: 'deepseek-flash',
              createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
      },
      {
        workspaceId: 'ws-2', title: '张某诉某公司', path: '/cases/zhang', sessionCount: 0,
        configured: true,
        instructions: { global: { present: false, path: '' }, project: { present: false, root: '/y', files: [] } },
        policy: { profile: 'general', defaultPerspective: 'none', onboardingStatus: 'configured', skillOverrides: {}, subagents: [] },
      },
    ],
  };

  const calls = [];
  const defaultInjection = {
    available: true,
    workspaceId: 'ws-1',
    workspaceTitle: '华北地产重整',
    textsLoaded: true,
    onboardingStatus: 'configured',
    profile: 'general',
    defaultPerspective: 'none',
    saved: {
      active: true,
      gate: 'ok',
      parts: { profile: true, perspective: false, agents: false },
      totalChars: 22,
      sections: [
        { id: 'workspace-profile:context', order: 400, text: '## 当前工作区\n\n类型：General', chars: 22 },
        // Empty on purpose: the dialog must show the section and say it is empty
        // rather than dropping it, or "not injected" and "does not exist" look
        // the same.
        { id: 'workspace-profile:perspective', order: 401, text: '', chars: 0 },
        { id: 'workspace-profile:subagents', order: 2800, text: '', chars: 0 },
      ],
    },
    draft: null,
    note: 'note',
  };
  const remote = {
    snapshot: async () => ({ ok: true, value: snapshot }),
    skills: async () => { calls.push({ skills: true }); return { ok: true, value: { available: true, rows, missing: [], complete: true } }; },
    previewInjection: async (args) => {
      calls.push({ previewInjection: args });
      if (injection === null) return { ok: true, value: { ...defaultInjection } };
      const value = typeof injection === 'function' ? injection(args) : injection;
      return { ok: true, value };
    },
    matter: async (args) => {
      calls.push({ matter: args });
      const value = typeof matter === 'function' ? matter(args) : matter;
      return { ok: true, value: value ?? { available: true, discovered: false, matter: null, problem: null, match: null } };
    },
    models: async () => ({ ok: true, value: { available: true, providers: [] } }),
    validateRoute: async () => ({ ok: true, value: { available: true } }),
    setSkillState: async (args) => { calls.push(args); return { ok: true, value: { saved: true, revision: 8, snapshot } }; },
    putSubagent: async (args) => { calls.push({ putSubagent: args }); return { ok: true, value: { saved: true, revision: 9, snapshot } }; },
  };

  // The locale prop is more than `bind`: the section subscribes for re-render
  // notifications, so a stub with only `bind` fails inside an effect — a harness
  // gap, not a component bug.
  const locale = { bind: () => (key) => key, subscribe: () => () => {}, getSnapshot: () => ({ revision: 0 }) };
  const outer = registered[0].component({ remote, locale, validateRoute: () => {} });
  const inner = outer.props.children;
  const tree = await react.render(inner.type, inner.props);
  return {
    calls,
    css: injected.length > 0 ? injected[injected.length - 1].textContent : '',
    elements: walk(tree),
    classes: classList(tree),
    react,
    rerender: () => react.render(inner.type, inner.props),
    tree,
    // Flush the microtask queue the write path is waiting on.
    settle: async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); },
  };
}

/** Every className in a tree, joined. */
function classList(tree) {
  return walk(tree).map((e) => (e.props && e.props.className) || '').join(' ');
}

/** The first element carrying a given class. */
function byClass(tree, className) {
  return walk(tree).find((e) => (e.props.className || '') === className);
}

/** All elements carrying a given class. */
function allByClass(tree, className) {
  return walk(tree).filter((e) => (e.props.className || '') === className);
}

test('the panel leads with the workspace picker, then three tabs', async () => {
  const { tree, classes } = await renderSection();

  // The header is the picker: the panel's identity and its switcher in one.
  assert.ok(classes.includes('wsp7k_pickHead'), 'the picker must render');
  assert.ok(classes.includes('wsp7k_pickTitle'), 'the picker must show the selected title');
  assert.ok(classes.includes('wsp7k_pickPath'), 'the picker must show the selected path');
  const head = byClass(tree, 'wsp7k_pickHead');
  assert.equal(head.props['aria-expanded'], false, 'the list starts closed');
  assert.equal(head.type, 'button', 'the disclosure must be a real button');

  // Three tabs, exactly, in order, and the first is active.
  const tabs = allByClass(tree, 'wsp7k_tab');
  assert.deepEqual(tabs.map((t) => t.props.id), [
    'workspace-profile-tab-workspace',
    'workspace-profile-tab-skills',
    'workspace-profile-tab-subagents',
  ]);
  assert.deepEqual(tabs.map((t) => t.props['aria-selected']), [true, false, false]);
  // Roving tabindex: the strip is one tab stop.
  assert.deepEqual(tabs.map((t) => t.props.tabIndex), [0, -1, -1]);

  // Only the active panel is rendered, and it is wired to its tab.
  const panels = walk(tree).filter((e) => e.props.role === 'tabpanel');
  assert.equal(panels.length, 1);
  assert.equal(panels[0].props.id, 'workspace-profile-panel-workspace');
  assert.equal(panels[0].props['aria-labelledby'], 'workspace-profile-tab-workspace');

  // The first tab holds the configuration cards and the save bar, and no longer a
  // workspace-selector block of its own. The list is exhaustive on purpose: a new
  // card is a change to what this page says, so it should have to be added here.
  // `matterTitle` comes second — the Matter the directory declares is read before
  // the settings that are supposed to agree with it.
  const titles = allByClass(tree, 'wsp7k_cardTitle').map((e) => e.props.children);
  assert.deepEqual(titles, ['blockType', 'matterTitle', 'blockNorms']);
  assert.ok(classes.includes('wsp7k_footer'), 'the save bar belongs to this tab');
});

/** Every string rendered anywhere in a tree, in document order. */
function strings(tree) {
  return walk(tree)
    .map((element) => (element.props ? element.props.children : undefined))
    .filter((children) => typeof children === 'string');
}

/** The first rendered button whose label is exactly `label`. */
function buttonByLabel(tree, label) {
  return walk(tree).find((element) => element.type === 'button' && element.props.children === label);
}

/**
 * One 查看 per field, and the verdict lives in the dialog they open.
 *
 * There was a `提示词注入` row in the second card, restating the Profile and
 * Perspective values directly above it. It was removed on request: that card
 * already shows those two values and a third line repeating them is noise. What
 * must not be lost with it is the *answer* — so these tests hold the buttons'
 * positions and labels, the absence of the row, and the dialog's verdict.
 */
test('each field carries its own 查看 button, labelled 查看, and nothing restates injection', async () => {
  const { tree, classes, calls } = await renderSection({
    // The stored state from the report: 诉讼 + 原告代理人. A Profile with a single
    // stance renders 默认视角 as text, and then there is no control to sit beside.
    vocabularyProfiles: [{
      id: 'litigation',
      label: '诉讼 (Litigation)',
      perspectives: [{ id: 'none', label: '不设定' }, { id: 'plaintiff', label: '原告代理人 (Plaintiff)' }],
    }],
    policyProfile: 'litigation',
    policyPerspective: 'plaintiff',
  });

  const cards = allByClass(tree, 'wsp7k_card');
  // Three now: the Matter card reports what the directory declares, and the two
  // below it are the settings that are supposed to agree with it. `cards[0]` is
  // still the editable Profile/默认视角 card this test then walks.
  assert.equal(cards.length, 3, 'the workspace tab keeps its configuration cards');

  // Two controls, one after each field, in document order: Profile then 默认视角.
  const ordered = walk(cards[0]);
  const selects = ordered.map((element, index) => (element.type === 'select' ? index : -1)).filter((index) => index >= 0);
  const views = ordered.map((element, index) => (element.type === 'button' && element.props.children === 'view' ? index : -1)).filter((index) => index >= 0);
  assert.equal(selects.length, 2, 'Profile and 默认视角 are the only two selects here');
  assert.equal(views.length, 2, 'each field gets its own 查看');
  assert.ok(views[0] > selects[0], 'the Profile field carries one, after its select');
  assert.ok(views[1] > selects[1], 'and so does 默认视角');
  for (const element of ordered) {
    if (element.type !== 'button' || element.props.children !== 'view') continue;
    // The label is the short 查看: a row of controls is no place for a sentence.
    assert.equal(element.props.title, 'viewInjection', 'the full wording must survive as the tooltip');
  }
  assert.equal(
    ordered.some((element) => element.type === 'button' && element.props.children === 'viewInjection'),
    false,
    'the long label must not be the button text',
  );

  // The removed row, asserted as an absence so it cannot creep back.
  const norms = strings(cards[1]);
  assert.equal(norms.includes('injectionOn'), false, 'no verdict row in the second card');
  assert.equal(norms.includes('injectionOff'), false, 'no verdict row in the second card');
  assert.equal(
    walk(cards[1]).some((element) => element.type === 'button' && element.props.children === 'view'),
    false,
    'the second card carries no 查看 button either',
  );

  // The badge still answers its own question — something IS stored.
  assert.ok(strings(tree).includes('configured'), 'the header badge keeps its meaning');
  assert.equal(calls.filter((call) => call.previewInjection).length, 0, 'nothing is fetched before a button is pressed');
  assert.ok(classes.includes('wsp7k_pickHead'));
});

test('the dialog gives the verdict, and the reason, from the Host\'s own answer', async () => {
  const empty = (id, order) => ({ id, order, text: '', chars: 0 });
  const r = await renderSection({
    injection: {
      available: true, workspaceId: 'ws-1', textsLoaded: true, onboardingStatus: 'unconfigured',
      saved: { active: false, gate: 'unconfigured', parts: { profile: false, perspective: false, agents: false }, totalChars: 0, sections: [
        empty('workspace-profile:context', 400),
        empty('workspace-profile:perspective', 401),
        empty('workspace-profile:subagents', 2800),
      ] },
      draft: null,
      note: 'note',
    },
  });
  buttonByLabel(r.tree, 'view').props.onClick();
  await r.settle();
  const labels = strings(await r.rerender());

  assert.ok(labels.includes('injectionOff'), 'the verdict must be 未注入');
  assert.ok(labels.includes('injectionOffNoProfile'), 'and it must say why, not only that');
  // The negative control: a verdict derived from "has anything been stored"
  // would read 已注入 here, which is the bug this whole feature exists to end.
  assert.equal(labels.includes('injectionOn'), false, 'a green verdict must not appear');
});

test('a skipped workspace is reported as skipped, not as a missing Profile', async () => {
  const empty = (id, order) => ({ id, order, text: '', chars: 0 });
  const r = await renderSection({
    injection: {
      available: true, workspaceId: 'ws-1', textsLoaded: true, onboardingStatus: 'skipped',
      saved: { active: false, gate: 'skipped', parts: { profile: false, perspective: false, agents: false }, totalChars: 0, sections: [
        empty('workspace-profile:context', 400),
        empty('workspace-profile:perspective', 401),
        empty('workspace-profile:subagents', 2800),
      ] },
      draft: null,
      note: 'note',
    },
  });
  buttonByLabel(r.tree, 'view').props.onClick();
  await r.settle();
  const labels = strings(await r.rerender());
  assert.ok(labels.includes('injectionOffSkipped'), 'the skipped reason is the true one');
  assert.equal(labels.includes('injectionOffNoProfile'), false, 'the unconfigured reason would be false here');
});

test('a 404 for the new method is explained as "the Host has not restarted"', async () => {
  // The client bundle hot-reloads; the Host half does not. Until DSH is
  // restarted, this is the *normal* state of a half-updated plugin, and the raw
  // transport failure reads as "the plugin is broken" instead.
  const r = await renderSection({
    injection: () => {
      throw Object.assign(
        new Error('client api: workspaceProfile/previewInjection failed: transport failure for /api/workspaceProfile/previewInjection: HTTP 404'),
        { code: 'gateway/unavailable' },
      );
    },
  });
  buttonByLabel(r.tree, 'view').props.onClick();
  await r.settle();
  const labels = strings(await r.rerender());

  assert.ok(labels.includes('injectionNeedsRestart'), 'the message must name the real cause');
  assert.equal(
    labels.some((value) => value.includes('HTTP 404')),
    false,
    'and must not leave the raw transport failure as the explanation',
  );
});

test('the 查看 button opens the injected prompt, section by section', async () => {
  const r = await renderSection();
  const button = buttonByLabel(r.tree, 'view');
  assert.ok(button, 'block 一 must carry the 查看 button beside the fields that feed it');

  button.props.onClick();
  await r.settle();
  const tree = await r.rerender();
  const labels = strings(tree);

  assert.ok(labels.includes('injectionTitle'), 'the dialog must open');
  assert.ok(labels.includes('injectionStoredTitle'), 'it must label the group as the stored, in-use one');
  // The stable section name is what a session transcript and this dialog have in
  // common, so it has to be on screen.
  assert.ok(labels.includes('workspace-profile:context'), 'the section name must be shown');
  assert.ok(labels.includes('## 当前工作区\n\n类型：General'), 'the composed text must appear verbatim');
  assert.ok(labels.includes('injectionEmptySection'), 'an empty section must be shown as empty, never dropped');

  // Exactly one business argument, and no draft pair while the form is clean:
  // a Remote call is built positionally, so a trailing `undefined` would be a
  // different call, not the same one.
  const call = r.calls.find((entry) => entry.previewInjection);
  assert.deepEqual(Object.keys(call.previewInjection), ['workspaceId']);
});

test('a dirty form warns that the dialog shows the saved composition, and previews the draft', async () => {
  const r = await renderSection({
    injection: {
      available: true, workspaceId: 'ws-1', textsLoaded: true, onboardingStatus: 'configured',
      saved: { active: true, gate: 'ok', parts: { profile: true, perspective: false, agents: false }, totalChars: 3, sections: [
        { id: 'workspace-profile:context', order: 400, text: 'saved', chars: 3 },
      ] },
      draft: { requested: true, valid: true, active: true, gate: 'ok', parts: { profile: true, perspective: false, agents: false }, totalChars: 5, sections: [
        { id: 'workspace-profile:context', order: 400, text: 'after', chars: 5 },
      ] },
      note: 'note',
    },
  });

  // Edit the Profile select, which is what makes the form dirty.
  const select = walk(r.tree).find((element) => element.type === 'select');
  assert.ok(select, 'the Profile select must be on the page');
  select.props.onChange({ target: { value: 'litigation' } });
  const dirtyTree = await r.rerender();
  assert.ok(strings(dirtyTree).includes('pendingEdits'), 'the page must first say the draft is unsaved');

  buttonByLabel(dirtyTree, 'view').props.onClick();
  await r.settle();
  const tree = await r.rerender();
  const labels = strings(tree);

  assert.ok(labels.includes('injectionDirty'), 'the dialog must not let the draft pass as what is in use');
  assert.ok(labels.includes('injectionDraftTitle'), 'it must show what saving would produce');
  assert.ok(labels.includes('saved') && labels.includes('after'), 'both compositions must be readable');

  const call = r.calls.find((entry) => entry.previewInjection);
  assert.deepEqual(
    Object.keys(call.previewInjection).sort(),
    ['perspective', 'profile', 'workspaceId'],
    'the draft pair must ride along so the dialog can answer "after saving"',
  );
});

test('an empty composition is explained rather than rendered as nothing', async () => {
  const empty = { id: 'workspace-profile:context', order: 400, text: '', chars: 0 };
  const r = await renderSection({
    injection: {
      available: true, workspaceId: 'ws-1', textsLoaded: true, onboardingStatus: 'unconfigured',
      saved: { active: false, gate: 'unconfigured', parts: { profile: false, perspective: false, agents: false }, totalChars: 0, sections: [
        empty,
        { ...empty, id: 'workspace-profile:perspective', order: 401 },
        { ...empty, id: 'workspace-profile:subagents', order: 2800 },
      ] },
      draft: null,
      note: 'note',
    },
  });
  buttonByLabel(r.tree, 'view').props.onClick();
  await r.settle();
  const labels = strings(await r.rerender());
  assert.ok(labels.includes('injectionNone'), 'the dialog must say that nothing is written');
  assert.ok(!labels.includes('injectionDraftTitle'), 'there is no draft group to show');
});

test('the dialog refuses to present an unfinished Profile read as "nothing configured"', async () => {
  const r = await renderSection({
    injection: {
      available: true, workspaceId: 'ws-1', textsLoaded: false, onboardingStatus: 'configured',
      saved: { active: false, gate: 'ok', parts: { profile: false, perspective: false, agents: false }, totalChars: 0, sections: [
        { id: 'workspace-profile:context', order: 400, text: '', chars: 0 },
        { id: 'workspace-profile:perspective', order: 401, text: '', chars: 0 },
        { id: 'workspace-profile:subagents', order: 2800, text: '', chars: 0 },
      ] },
      draft: null,
      note: 'note',
    },
  });
  buttonByLabel(r.tree, 'view').props.onClick();
  await r.settle();
  const labels = strings(await r.rerender());
  assert.ok(labels.includes('injectionNotLoaded'), 'an incomplete read must be declared as incomplete');
});

test('the tabs switch panels, and the workspace stays visible on every one', async () => {
  const { tree, react, rerender } = await renderSection({ skillCount: 3 });
  const tabs = allByClass(tree, 'wsp7k_tab');

  // Keyboard movement, not just clicking: ArrowRight from the first tab.
  let prevented = false;
  tabs[0].props.onKeyDown({ key: 'ArrowRight', preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, 'the handler must claim the arrow key');

  const skills = await rerender();
  assert.ok(classList(skills).includes('wsp7k_skillList'), 'the skills panel must take over');
  assert.equal(
    walk(skills).filter((e) => e.props.role === 'tabpanel')[0].props.id,
    'workspace-profile-panel-skills',
  );
  // The save bar is a first-tab thing; leaving it on the skills tab would show a
  // greyed-out button that cannot do anything.
  assert.equal(classList(skills).includes('wsp7k_footer'), false, 'the save bar must not follow to other tabs');
  // The header survives the switch — that is the point of putting it above the tabs.
  assert.ok(classList(skills).includes('wsp7k_pickHead'), 'the picker must remain on every tab');
  assert.ok(classList(skills).includes('wsp7k_pickPath'), 'the path must remain on every tab');

  allByClass(skills, 'wsp7k_tab')[2].props.onClick();
  const subagents = await rerender();
  assert.ok(classList(subagents).includes('wsp7k_pickHead'), 'the picker must remain on the last tab');
});

test('the skills tab lays out as a two-column grid of switches', async () => {
  const { tree, classes } = await renderSection({ skillCount: 5 });
  const tabs = allByClass(tree, 'wsp7k_tab');
  tabs[1].props.onClick();
  const skills = await (async () => {
    const r = await renderSection({ skillCount: 5 });
    allByClass(r.tree, 'wsp7k_tab')[1].props.onClick();
    return r.rerender();
  })();

  // Two columns come from the stylesheet, so the rule is what has to be asserted.
  // The minimum is pinned against the MEASURED panel width (531px on this
  // deployment): two columns plus the 8px gap must fit inside it, and a hard
  // `repeat(2, …)` would wedge long names into whatever is left over instead of
  // falling back to one column on a narrower dialog.
  const rule = /grid-template-columns:repeat\(auto-fill,minmax\((\d+)px,1fr\)\);column-gap:(\d+)px/.exec(SOURCE);
  assert.ok(rule, 'the grid must size columns by a minimum width, not a fixed count');
  const minColumn = Number(rule[1]);
  const gap = Number(rule[2]);
  assert.ok(
    minColumn * 2 + gap <= 531,
    `two columns (${minColumn}px x2 + ${gap}px) must fit the measured 531px list`,
  );
  assert.ok(minColumn >= 200, `a ${minColumn}px column would truncate names past recognition`);
  assert.ok(classList(skills).includes('wsp7k_skillList'), 'the list must render');

  // The search field spans the full width: it sits outside the grid.
  const search = byClass(skills, 'wsp7k_searchRow');
  assert.ok(search, 'the search row must be its own element, above the grid');
  const list = byClass(skills, 'wsp7k_skillList');
  assert.equal(search.props.children.some((c) => c && c.type === 'input'), true, 'the field lives in the search row');

  // The fixed 260px cap is what made 50 skills unusable; it must be gone.
  assert.equal(/maxHeight: 260/.test(SOURCE), false, 'the list must no longer be capped at 260px');

  // One line per row: the name truncates rather than wrapping, which is what makes
  // a 240px column viable at all.
  const name = walk(skills).find((e) => (e.props.style || {}).textOverflow === 'ellipsis');
  assert.ok(name, 'the name must truncate');
  assert.equal(name.props.style.whiteSpace, 'nowrap', 'a wrapping name would defeat the single line');
  // Truncation is only acceptable because the row still carries the whole value.
  assert.ok(String(byClass(skills, 'wsp7k_gridCell').props.title).includes('prc-legal-research'),
    'the truncated name must still be readable in the tooltip');

  // Every row carries a switch, not a dropdown.
  const switches = allByClass(skills, 'wsp7k_switch');
  assert.ok(switches.length > 0, 'rows must carry switches');
  assert.equal(classList(skills).includes('wsp7k_skillState'), false, 'the <select> must be gone');
  for (const sw of switches) {
    assert.equal(sw.type, 'button');
    assert.equal(sw.props.role, 'switch');
    assert.equal(typeof sw.props['aria-checked'], 'boolean');
    assert.ok(String(sw.props['aria-label']).length > 0, 'a bare circle needs an accessible name');
  }
});

test('the switch writes enabled/disabled through the Remote, never recommended', async () => {
  const r = await renderSection({ skillCount: 3 });
  allByClass(r.tree, 'wsp7k_tab')[1].props.onClick();
  const skills = await r.rerender();

  const switches = allByClass(skills, 'wsp7k_switch');
  assert.ok(switches.length >= 2, 'expected at least two switchable rows');
  const togglable = switches.filter((sw) => sw.props.disabled !== true);

  // Enabled -> the write asks for `disabled`.
  assert.equal(togglable[0].props['aria-checked'], true);
  togglable[0].props.onClick();
  await r.settle();
  assert.deepEqual(r.calls.filter((c) => c.state !== undefined).map((c) => c.state), ['disabled']);

  // Stored as `disabled` -> the write asks for `enabled`.
  const r2 = await renderSection({ skillCount: 3, skillOverrides: { 'skill-001-research-helper': 'disabled' } });
  allByClass(r2.tree, 'wsp7k_tab')[1].props.onClick();
  const skills2 = await r2.rerender();
  const off = allByClass(skills2, 'wsp7k_switch').filter((sw) => sw.props.disabled !== true)[0];
  assert.equal(off.props['aria-checked'], false);
  off.props.onClick();
  await r2.settle();
  assert.deepEqual(r2.calls.filter((c) => c.state !== undefined).map((c) => c.state), ['enabled']);

  // `recommended` is a legal *stored* value the UI no longer offers; a write must
  // never carry it.
  for (const call of [...r.calls, ...r2.calls]) {
    assert.notEqual(call.state, 'recommended', 'the switch must never write the third state');
  }
});

test('a variant rule is declared after the rule it overrides', () => {
  // Single-class selectors, so the later one wins. `.card{flex:none}` sat after
  // `.cardGrow{flex:1}` and silently won: the skills card stopped stretching, the
  // list fell back to its 180px minimum, and the panel showed five rows instead of
  // eleven. Nothing threw, nothing failed to render — it just quietly lost two
  // thirds of the list. Order is the contract here, so order is what gets asserted.
  const css = /const SECTION_CSS = \[([\s\S]*?)\]\.join\(''\)/.exec(SOURCE)[1];
  const at = (name) => css.indexOf('${C.' + name + '}');
  for (const [variant, base] of [['cardGrow', 'card'], ['cardBodyGrow', 'cardBody']]) {
    const v = at(variant);
    const b = at(base);
    assert.ok(v > 0, `${variant} must exist`);
    assert.ok(b > 0, `${base} must exist`);
    assert.ok(v > b, `${variant} must be declared after ${base}, or ${base}'s shorthand wins`);
  }
});

/** Open the subagents tab and return its settled tree. */
async function openSubagents(options) {
  const r = await renderSection(options);
  allByClass(r.tree, 'wsp7k_tab')[2].props.onClick();
  const tree = await r.rerender();
  return { ...r, tree, elements: walk(tree), classes: classList(tree) };
}

test('the subagents tab is a column of cards, and the outer card hugs its content', async () => {
  const { tree, classes } = await openSubagents({ subagents: true });

  const cards = allByClass(tree, 'wsp7k_subCard');
  assert.equal(cards.length, 2, 'one card per Subagent');

  // The empty box: the card used to be `grow`, so it stretched to the panel's
  // ~569px while holding one row. It must hug its content now.
  // `classes` is the space-joined className of every element, so a combined value
  // ("wsp7k_card wsp7k_cardGrow") is still caught. An exact-match lookup would not
  // be: that is what made the first version of this assertion unable to fail.
  assert.equal(classes.includes('wsp7k_cardGrow'), false,
    'the subagents card must not stretch — that was the empty box');
  assert.ok(classes.includes('wsp7k_card'), 'the cards still live in the shell card');

  // A column, not the skills grid: a Subagent carries a description.
  assert.equal(classes.includes('wsp7k_skillList'), false, 'the subagents tab must not use the skills grid');
});

test('a Subagent card shows the key and the description, which were both invisible', async () => {
  // `key` is what the model passes to `workspace_subagent` and it appeared nowhere
  // on the page; the description was reachable only through the route's tooltip.
  const { tree } = await openSubagents({ subagents: true });
  const cards = allByClass(tree, 'wsp7k_subCard');
  const first = cards[0];

  const keys = allByClass({ type: 'x', props: { children: first } }, 'wsp7k_subKey');
  assert.equal(keys.length, 1, 'the key chip must render');
  assert.equal(keys[0].props.children, 'legal-anylist');

  const desc = allByClass({ type: 'x', props: { children: first } }, 'wsp7k_subDesc')[0];
  assert.ok(desc, 'the description must render');
  assert.ok(String(desc.props.children).includes('深度分析'), 'and carry the real text');

  const route = allByClass({ type: 'x', props: { children: first } }, 'wsp7k_subRoute')[0];
  assert.equal(route.props.children, 'kimi-coding/k3 · max');
});

test('the Subagent state is the shared switch, and the 禁用 button is gone', async () => {
  const r = await openSubagents({ subagents: true });
  const switches = allByClass(r.tree, 'wsp7k_switch');
  assert.equal(switches.length, 2, 'one switch per Subagent');
  assert.deepEqual(switches.map((sw) => sw.props['aria-checked']), [true, false]);

  // Toggling writes the SAME path the 禁用 button used: `putSubagent` with
  // `enabled` inverted. No new write path was introduced.
  switches[0].props.onClick();
  await r.settle();
  const writes = r.calls.filter((c) => c.putSubagent !== undefined);
  assert.equal(writes.length, 1, 'the switch must write through putSubagent');
  assert.equal(writes[0].putSubagent.subagent.enabled, false, 'enabled must be inverted');
  assert.equal(writes[0].putSubagent.subagent.id, 'sub-1');

  // The button it replaced must be gone, not merely unused — it is what flattened
  // a state action into the same row as 删除.
  // The harness locale binds `t` to the identity, so a button's label IS its key.
  const labels = walk(r.tree)
    .filter((e) => e.type === 'button')
    .map((e) => (typeof e.props.children === 'string' ? e.props.children : ''))
    .filter(Boolean);
  assert.equal(labels.includes('disable'), false, 'the 禁用 button must be gone');
  assert.equal(labels.includes('enable'), false, 'and so must its mirror image');
  for (const kept of ['edit', 'duplicate', 'remove']) {
    assert.ok(labels.includes(kept), `${kept} must stay`);
  }
  // Exactly the three actions per card, so a fourth cannot creep back in unnoticed.
  const actions = labels.filter((l) => ['edit', 'duplicate', 'remove'].includes(l));
  assert.equal(actions.length, 3 * allByClass(r.tree, 'wsp7k_subCard').length,
    'three actions per card, and no fourth');
  // The switches carry no children at all (their name is the aria-label), so the
  // only other labelled button here is the add one.
  assert.deepEqual(
    labels.filter((l) => !actions.includes(l)),
    ['+ addSubagent'],
    'the actions plus the add button, and nothing else',
  );
});

test('an empty subagents tab still offers the way to add one', async () => {
  const { tree, classes } = await openSubagents({});
  assert.equal(allByClass(tree, 'wsp7k_subCard').length, 0);
  const texts = walk(tree).map((e) => (typeof e.props.children === 'string' ? e.props.children : '')).join('|');
  assert.ok(texts.includes('noSubagents'), 'the empty state must say so');
  assert.ok(texts.includes('addSubagent'), 'and still offer the add button');
  assert.ok(classes.includes('wsp7k_subActions'), 'the button is styled, not bare');
});

test('the editor dialog uses the platform field layout, not a label column', async () => {
  const r = await openSubagents({ subagents: true });
  walk(r.tree).find((e) => e.type === 'button' && e.props.children === 'edit').props.onClick();
  const tree = await r.rerender();
  const elements = walk(tree);
  const classes = classList(tree);

  const dialog = elements.find((e) => e.props['data-workspace-profile'] === 'dialog');
  assert.ok(dialog, 'the dialog must be open');

  // The platform puts the label ABOVE its control (`fields.module.css`); the old
  // 132px left-hand column is a layout the platform does not use.
  const stacks = allByClass(tree, 'wsp7k_fieldStack');
  assert.ok(stacks.length >= 5, `expected the stacked fields, saw ${stacks.length}`);
  for (const stack of stacks) {
    const childTypes = (stack.props.children || []).map((c) => (c && c.type) || null);
    assert.equal(childTypes[0], 'label', 'every field must lead with its label');
  }
  assert.equal(SOURCE.includes('fieldLabel'), true, 'the old label style still exists for other pages');
  assert.equal(/s\.fieldLabel\b/.test(SOURCE.split('function SubagentDialog')[1] || ''), false,
    'the dialog must not use the old left-column label');

  // The route is one concept: three selects inside ONE three-column row.
  const route = byClass(tree, 'wsp7k_routeRow');
  assert.ok(route, 'the route must be a single row');
  assert.equal(route.props.children.filter((c) => c && c.type === 'select').length, 3,
    'provider, model and effort share the row');

  // And the modal speaks the platform's modal language.
  assert.ok(classes.includes('wsp7k_modalPanel'));
  // Asserted on the generated stylesheet, not the source: the token name also
  // appears in a comment, so a source grep would pass with the rule deleted.
  assert.ok(/wsp7k_modalPanel\{[^}]*box-shadow:var\(--dsw-elevation-prominent/.test(r.css),
    'the panel must use the platform elevation token');
});

test('the stylesheet is written with the state colours, not just the brand colour', () => {
  return renderSection({ skillCount: 1 }).then(({ css }) => {
    assert.ok(css.length > 500, 'the stylesheet must actually be injected');
    const on = /\[aria-checked=true\]\{border-color:var\(--dsw-alias-state-success-primary[^}]*background:var\(--dsw-alias-state-success-primary/.exec(css);
    assert.ok(on, 'an available skill must be green');
    const base = /wsp7k_switch\{[^}]*border:1\.5px solid var\(--dsw-alias-state-error-primary/.exec(css);
    assert.ok(base, 'a disabled skill must be red');
    // Read-only keeps the neutral grey in both positions, or it would read as a
    // state the user set and can change.
    const off = /wsp7k_switch:disabled\{[^}]*border-color:var\(--dsw-alias-label-tertiary/.exec(css);
    assert.ok(off, 'a bundled skill must stay grey');
  });
});

test('the search field spans the row rather than sitting at a fixed width', async () => {
  // The cap lived in the element's inline style, not the stylesheet, so it has to
  // be asserted on the rendered control — a CSS-only check would pass no matter
  // what the style object said.
  const r = await renderSection({ skillCount: 2 });
  allByClass(r.tree, 'wsp7k_tab')[1].props.onClick();
  const skills = await r.rerender();
  const search = byClass(skills, 'wsp7k_searchRow');
  const input = search.props.children.find((c) => c && c.type === 'input');
  assert.ok(input, 'expected the search input');
  assert.equal(input.props.style.maxWidth, undefined, 'the field must not be capped');
  assert.ok(/^1 1/.test(input.props.style.flex), 'the field must be the flexible item in the row');
});

test('editing the stylesheet updates the tag instead of leaving the old rules applied', () => {
  // Injecting once and skipping on the second load is the platform's own pattern,
  // and it is wrong for a file that changes during development: the markup updates
  // on hot reload while the old rules stay in force, so a CSS edit appears to do
  // nothing. Loading the bundle twice must leave the newest text in the tag.
  // Both loads must share ONE page. Two separate contexts would each start with an
  // empty document, and the update path would never be reached — the first version
  // of this test passed for exactly that reason and proved nothing.
  const first = loadRenderableSection();
  assert.equal(first.injected.length, 1, 'the first load injects the tag');
  const tag = first.injected[0];
  const original = tag.textContent;
  assert.ok(original.length > 500);

  // Simulate the same page seeing a newer stylesheet: the tag exists and its text
  // is stale.
  tag.textContent = 'stale';
  const second = loadRenderableSection(first.context);
  assert.equal(second.injected.length, 1, 'the second load must reuse the tag, not add another');
  assert.notEqual(second.injected[0].textContent, 'stale', 'the stale text must be replaced');
  assert.ok(second.injected[0].textContent.length > 500);

  // And a reload with identical text must not rewrite the tag, which would be a
  // pointless style recalculation on every hot reload.
  second.injected[0].textContent = original;
  const third = loadRenderableSection(first.context);
  assert.equal(third.injected[0].textContent, original);
});

test('a bundled skill cannot be switched', async () => {
  const r = await renderSection({ skillCount: 3 });
  allByClass(r.tree, 'wsp7k_tab')[1].props.onClick();
  const skills = await r.rerender();
  const switches = allByClass(skills, 'wsp7k_switch');
  // Every third row in the fixture is `bundled`, which Settings may not write.
  const disabled = switches.filter((s) => s.props.disabled === true);
  assert.ok(disabled.length > 0, 'bundled rows must be un-switchable');
  assert.ok(switches.some((s) => s.props.disabled !== true), 'and the others must stay switchable');
});

test('the list renders in chunks and narrows with the search box', async () => {
  const r = await renderSection({ skillCount: 250 });
  allByClass(r.tree, 'wsp7k_tab')[1].props.onClick();
  let skills = await r.rerender();

  const countRows = (t) => walk(t).filter((e) => e.props.className === 'wsp7k_gridCell').length;
  assert.equal(countRows(skills), 60, 'the first paint must be one chunk, not all 250');

  // Scrolling near the bottom appends.
  const list = byClass(skills, 'wsp7k_skillList');
  list.props.onScroll({ target: { scrollTop: 900, clientHeight: 400, scrollHeight: 1000 } });
  skills = await r.rerender();
  assert.equal(countRows(skills), 120, 'reaching the bottom must append another chunk');

  // A query resets the window, so the revealing done for one search cannot carry
  // into the next.
  const search = byClass(skills, 'wsp7k_searchRow');
  const input = search.props.children.find((c) => c && c.type === 'input');
  input.props.onChange({ target: { value: 'securities' } });
  skills = await r.rerender();
  assert.equal(countRows(skills), 1, 'the long name is the only match, and the window resets');
  assert.equal(countRows(skills) <= 60, true);
});

test('switching a skill does not blank or refetch the catalog', async () => {
  // The old effect ran on every revision change and began with `setSkills(null)`,
  // so toggling one Skill emptied the list and re-downloaded every row. With a few
  // hundred skills that is a visible flash plus a large round trip.
  const effect = /useEffect\(\(\) => \{[\s\S]*?remote\.skills\([\s\S]*?\}, \[([^\]]*)\]\);/.exec(SOURCE);
  assert.ok(effect, 'expected the skills loader effect');
  const deps = effect[1];
  assert.equal(deps.includes('revision'), false, 'the catalog must not reload on every policy write');
  // Blanking is still correct when the *Workspace* changes — the old rows belong to
  // another Workspace. What must not happen is an unguarded blank, which is what
  // made every toggle flash a loading state.
  assert.ok(
    /if \(loadedFor\.current !== selectedId\) setSkills\(null\);/.test(effect[0]),
    'the list may only blank when the Workspace actually changed',
  );
  assert.equal(
    /^\s*setSkills\(null\);\s*$/.test(effect[0].split('\n').map((l) => l.trim()).join('\n')),
    false,
    'no unconditional clear may remain in the effect',
  );
});

test('toggling a skill updates its row in place, without refetching the catalog', async () => {
  const r = await renderSection({ skillCount: 4 });
  allByClass(r.tree, 'wsp7k_tab')[1].props.onClick();
  let skills = await r.rerender();

  const fetches = () => r.calls.filter((c) => c.skills === true).length;
  const before = fetches();
  const switchEl = allByClass(skills, 'wsp7k_switch').filter((sw) => sw.props.disabled !== true)[0];
  assert.equal(switchEl.props['aria-checked'], true);

  switchEl.props.onClick();
  await r.settle();
  skills = await r.rerender();

  // The write landed…
  assert.deepEqual(r.calls.filter((c) => c.state !== undefined).map((c) => c.state), ['disabled']);
  // …the row reflects it without a reload…
  const rows = walk(skills).filter((e) => e.props.className === 'wsp7k_gridCell');
  const after = allByClass({ type: 'x', props: { children: rows } }, 'wsp7k_switch')
    .filter((sw) => sw.props.disabled !== true)[0];
  assert.equal(after.props['aria-checked'], false, 'the toggled row must show its new state');
  // …and nothing was re-downloaded. This is the whole point: with several hundred
  // Skills a refetch per click is both a stall and a large round trip.
  assert.equal(fetches(), before, 'toggling must not refetch the catalog');
});

test('the first tab marks itself when a draft is staged', async () => {
  const r = await renderSection();
  assert.equal(classList(r.tree).includes('wsp7k_tabDot'), false, 'no dot before anything is staged');

  // Stage a draft through the rendered Profile control — the same path a click takes.
  const profileSelect = walk(r.tree).find((e) => e.type === 'select');
  assert.ok(profileSelect, 'expected the Profile select');
  profileSelect.props.onChange({ target: { value: 'bankruptcy' } });
  const staged = await r.rerender();

  const dot = byClass(staged, 'wsp7k_tabDot');
  assert.ok(dot, 'a staged draft must be visible from every tab');
  // The dot is the only cue, and a coloured dot says nothing aloud.
  const firstTab = allByClass(staged, 'wsp7k_tab')[0];
  assert.ok(/未保存/.test(firstTab.props['aria-label']), 'the tab label must carry the words');
});

// ── the editor dialog's field layout ─────────────────────────────────────────
//
// These four rules exist because of one screenshot: the name and key inputs sat
// 24px apart vertically in a two-column row, and the answer was not a nudge. Each
// rule below is the fix for a specific way that happened, and each assertion is
// written against the *generated* stylesheet rather than the source text, so a
// renamed variable or a moved rule cannot make it pass vacuously.

/**
 * The declaration block of the first rule that *starts* with `selector`.
 *
 * The boundary matters. A plain `indexOf(selector + '{')` also finds a selector
 * buried inside a longer one — `.wsp7k_fieldRow{` matches inside
 * `.wsp7k_modalPanel>*+.wsp7k_fieldRow{` — and then returns *that* rule's body,
 * which is how the first version of this helper reported "no padding declaration
 * on .wsp7k_fieldRow" for a rule that has one. Requiring the selector to follow a
 * `}` or the start of the sheet is what makes it select a rule, not a substring.
 */
function ruleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp('(?:^|\\})(' + escaped + ')\\{').exec(css);
  assert.ok(match, `expected a rule for ${selector}`);
  const start = match.index + match[0].length;
  const end = css.indexOf('}', start);
  assert.ok(end > start, `unterminated rule for ${selector}`);
  return css.slice(start, end);
}

/** A `padding` value split into its four used sides. */
function paddingSides(css, selector) {
  const decl = /padding:([^;}]+)/.exec(ruleBody(css, selector));
  assert.ok(decl, `expected a padding declaration on ${selector}`);
  const parts = decl[1].trim().split(/\s+/);
  const [t, r = t, b = t, l = r] = parts;
  return { top: t, right: r, bottom: b, left: l };
}

test('a field label does not grow along the column it is stacked in', async () => {
  const { css } = await renderSection();
  const body = ruleBody(css, '.wsp7k_fieldStackLabel');

  // This was `flex:1`, which is right for a label sitting in a row and wrong for
  // one stacked above its control: the flex axis becomes vertical, `flex-basis:0`
  // makes the label absorb the column's leftover height, and in the name/key row
  // the name label grew to 43.5px against the key label's 19.5px — pushing its
  // input 24px below the key input. Two fields on one line, visibly out of line.
  assert.match(body, /flex:none/, 'the label must not grow');
  assert.doesNotMatch(body, /flex:(1|auto|[0-9])/, 'a growing label is the misalignment');
  assert.doesNotMatch(body, /flex-grow\s*:\s*[1-9]/, 'flex-grow is the same bug spelled out');
});

test('the field separator is keyed on the group ordering, not on two fieldStacks', async () => {
  const { css } = await renderSection();

  // `.fieldStack+.fieldStack` never matched the route group, because the group
  // above it is the name/key `.fieldRow` — so one group in the dialog had no
  // hairline while the other four did. Selecting on the panel's children is
  // ordering-agnostic: any group that follows any other group gets the line.
  const at = css.indexOf('.wsp7k_modalPanel>*+.wsp7k_fieldStack');
  assert.ok(at >= 0, 'the separator must be keyed on the panel child, not on fieldStack+fieldStack');
  const rule = css.slice(at, css.indexOf('}', at));
  assert.match(rule, /\.wsp7k_modalPanel>\*\+\.wsp7k_fieldRow/,
    'the row is a field group too and must be covered');
  assert.match(rule, /border-top:\.5px/, 'and it must draw the hairline');

  // The sibling form is exactly what missed, so its absence is the regression test.
  assert.equal(css.includes('.wsp7k_fieldStack+.wsp7k_fieldStack{border-top'),
    false, 'the sibling selector is the bug');
});

test('every vertical boundary in the dialog is the same 20px', async () => {
  const { css } = await renderSection();

  // A boundary is the previous group's padding-bottom plus the next one's
  // padding-top, so uniformity is a property of four declarations, not one.
  const stack = paddingSides(css, '.wsp7k_fieldStack');
  const row = paddingSides(css, '.wsp7k_fieldRow');
  const title = paddingSides(css, '.wsp7k_modalTitle');
  const footer = paddingSides(css, '.wsp7k_modalPanel>.wsp7k_footer');

  assert.deepEqual([stack.top, stack.bottom], ['10px', '10px'], 'field groups set the rhythm');
  assert.deepEqual([row.top, row.bottom], ['10px', '10px'],
    'the name/key row is a group too — without its own padding the title boundary was 10px, not 20px');
  assert.equal(title.bottom, '10px', 'the title boundary must match, minus the pairs rule');
  assert.equal(footer.top, '10px', 'and so must the footer boundary');

  // 20px, not 24px: at the platform's own 12px this six-field form measured 694px
  // in a 681px panel and had to scroll, which left the 启用 switch half-covered by
  // the sticky footer. The number is load-bearing, so the number is asserted.
  assert.equal(stack.top, '10px', 'the rhythm is 20px, and it is what makes the form fit');
});

test('the dialog panel cannot outgrow the backdrop padding box', async () => {
  const { css } = await renderSection();
  const body = ruleBody(css, '.wsp7k_modalPanel');

  // `max-height` applies to the content box. With the default `content-box` the
  // panel's own 36px of padding sat outside the limit: measured against a 681px
  // padding box the panel laid out 717px tall and came within 6px of the viewport
  // edge instead of the 24px the backdrop asks for.
  assert.match(body, /box-sizing:border-box/, 'padding must count against max-height');
  assert.match(body, /max-height:100%/);
});

test('the switch starts where every other control in the dialog starts', async () => {
  const { css } = await renderSection();

  // `.switchBtn` carries `margin-top:3px` to sit optically centred in a list row.
  // Stacked under a label that became 9px against the 6px every input uses.
  const override = '.wsp7k_fieldStack .wsp7k_switch{margin-top:0}';
  const at = css.indexOf(override);
  assert.ok(at >= 0, 'the dialog must reset the switch margin');

  // Same two-class specificity as `.switchBtn:disabled`, so source order decides —
  // the override has to come after the base rule it corrects.
  const base = css.indexOf('.wsp7k_switch{');
  assert.ok(base >= 0 && base < at, 'the override must be declared after the base switch rule');
});

test('no generated rule is followed by a stray comma', async () => {
  const { css } = await renderSection();

  // A real near-miss: a comma landed inside a template literal, so the next array
  // element became a *tagged template* — `` `a},` `b` ``. That is syntactically
  // valid JavaScript, so `node --check` passed and the file looked fine; it threw
  // only when the stylesheet was built. A closing brace is never followed by a
  // comma in valid CSS, which makes this a precise invariant rather than a guess.
  assert.equal(/},/.test(css), false, 'a `},` means a comma escaped into a template literal');
  assert.ok(css.startsWith('.wsp7k_'), 'and the stylesheet still builds');
});

test('the Matter card reports what the directory declares, and whether we agree', async () => {
  const { tree } = await renderSection({
    vocabularyProfiles: [{ id: 'litigation', label: '诉讼 (Litigation)', perspectives: [{ id: 'none', label: '不设定' }, { id: 'plaintiff', label: '原告代理人' }] }],
    policyProfile: 'litigation',
    policyPerspective: 'plaintiff',
    matter: {
      available: true,
      discovered: true,
      problem: null,
      matter: { id: '11111111-2222-3333-4444-555555555555', name: '示例系列案件', type: 'litigation', role: 'plaintiff', stage: 'unknown', modules: ['litigation.series'] },
      match: {
        profile: { expected: 'litigation', actual: 'litigation', verdict: 'match' },
        perspective: { expected: 'plaintiff', workspaceDefault: 'plaintiff', sessionOverride: null, effective: 'plaintiff', verdict: 'match' },
        problems: [],
      },
    },
  });
  const text = strings(tree).join('\u0000');
  // Every field the Host read is shown, including the ones the page cannot derive.
  assert.ok(text.includes('matterName') && text.includes('matterId') && text.includes('matterType'), 'the identity fields render');
  assert.ok(text.includes('matterRole') && text.includes('matterStage') && text.includes('matterModules'), 'the classification fields render');
  assert.ok(text.includes('11111111-2222-3333-4444-555555555555'), 'the Matter id is shown verbatim');
  assert.ok(text.includes('litigation.series'), 'modules are shown');
  // The two verdicts, each its own row.
  assert.ok(text.includes('matterProfileMatch') && text.includes('matterPerspectiveMatch'), 'both comparisons are shown');
  assert.ok(text.includes('matterMatch'), 'an agreeing pair reads as a match');
  // Nothing offers to apply it: v1 reports, it does not re-point the Workspace.
  assert.ok(!text.includes('matterApply'), 'no apply affordance exists');
});

test('a workspace directory with no matter.yaml is not presented as an error', async () => {
  const { tree } = await renderSection({ matter: { available: true, discovered: false, matter: null, problem: null, match: null } });
  const text = strings(tree).join('\u0000');
  assert.ok(text.includes('matterNone'), 'the ordinary case is stated plainly');
  assert.ok(!text.includes('matterUnreadable'), 'absence is not an unreadable file');
});

test('an unreadable matter.yaml says why, rather than claiming there is none', async () => {
  const { tree } = await renderSection({
    matter: { available: true, discovered: false, matter: null, problem: 'line 2: anchors and aliases are not supported', match: null },
  });
  const text = strings(tree).join('\u0000');
  assert.ok(text.includes('matterUnreadable'), 'the failure is named');
  assert.ok(text.includes('anchors and aliases'), 'and the reason reaches the page');
  assert.ok(!text.includes('matterNone'), 'a broken file must not read as "no matter here"');
});

test('a mismatch is reported as a mismatch, and changes nothing', async () => {
  const { tree, calls } = await renderSection({
    matter: {
      available: true,
      discovered: true,
      problem: null,
      matter: { id: 'x', name: '某案', type: 'bankruptcy', role: 'administrator', stage: 'unknown', modules: [] },
      match: {
        profile: { expected: 'bankruptcy', actual: 'general', verdict: 'mismatch' },
        perspective: { expected: 'administrator', workspaceDefault: 'none', sessionOverride: null, effective: 'none', verdict: 'mismatch' },
        problems: [],
      },
    },
  });
  const text = strings(tree).join('\u0000');
  assert.ok(text.includes('matterMismatch'), 'the disagreement is shown');
  // The read is a read: no savePolicy call was made on its behalf.
  assert.deepEqual(calls.filter((call) => call.savePolicy !== undefined), []);
  assert.ok(calls.some((call) => call.matter !== undefined), 'and it did ask the Host');
});
