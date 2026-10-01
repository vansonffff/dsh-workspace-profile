// dsh-workspace-profile — the Workspace Composition Settings section.
//
// A classic script registered through `window.__ModuleLoader__.load`, with no
// bundler and no `import`. Only the platform seed is required: `react` and
// `react/jsx-runtime`. Nothing else is `require`d, so nothing else can fail to
// arrive.
//
// DSH client contract that matters here, all of it measured on this deployment
// rather than assumed:
//
//   * A Remote namespace is a *service* named `remote.<namespace>`, and it does
//     not exist until THIS bundle mounts its own contribution with
//     `ctx.remote.$mount(...)`. `dsh-api-remotes` mounts a hard-coded list of the
//     deployment's own namespaces and discovers nothing; a plugin that registers
//     its descriptor Host-side only, and then waits for `remote.<ns>`, waits
//     forever — silently, because a pending `ctx.inject` is not an error. So the
//     table below is a copy of the Host manifest and `apply` mounts it.
//   * Because of that, this file parks on `ctx.inject(['remote.workspaceProfile'], …)`
//     *after* mounting, instead of reading `ctx.remote.workspaceProfile` at
//     activation time: an uninjected read poisons the context permanently
//     (`cannot get property "…" without inject`).
//   * Every Remote call answers `{ok:true,value}` or `{ok:false,error}`; the
//     business value is one level in. `unwrap` accepts both shapes, because a
//     service method called in-process returns the bare value.
//   * The `settings.section` slot is a *list* seat, and its nav item and its page
//     body are the same registration: `id` is the nav key, `order` the position,
//     `label` the text. The shell passes exactly one prop, `{close}`; the slot's
//     `inject` factory return value is merged on top.
//   * `jsx`/`jsxs` take `children` as a PROP. A variadic third argument is
//     silently dropped by the real runtime, which is the worst possible failure
//     for a UI.
//   * `useState` lives only in real components. Calling a hook-bearing function
//     as a plain function attaches its hooks to the caller's chain and throws
//     React #310 the moment the row count changes, so components are always
//     rendered with `jsx(Component, props)`.
//   * The slot runtime swallows render exceptions and leaves an empty seat, so
//     every body is wrapped in an error boundary. Without one, any mistake here
//     shows as a blank panel and nothing else.
//   * `<button>` does not inherit font. Every button states `font: 'inherit'`.

window.__ModuleLoader__.load({
  id: 'dsh-workspace-profile',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    let react = require('react');
    let jsxRuntime = require('react/jsx-runtime');

    const { useCallback, useEffect, useMemo, useRef, useState, Component } = react;
    const { jsx, jsxs, Fragment } = jsxRuntime;

    const NS = 'settings.workspaceProfile';
    const SECTION_ID = 'workspace-profile';
    const SECTION_ORDER = 20;

    // ── design tokens ───────────────────────────────────────────────────────
    //
    // Only variables the running build actually defines, each with the value the
    // product resolves it to as a fallback. Inventing a token name produces a
    // property that silently does nothing.
    const token = (name, fallback) => 'var(' + name + ', ' + fallback + ')';
    const LABEL_PRIMARY = token('--dsw-alias-label-primary', '#0f1115');
    const LABEL_SECONDARY = token('--dsw-alias-label-secondary', '#61666b');
    const LABEL_TERTIARY = token('--dsw-alias-label-tertiary', '#81858c');
    const BORDER_L3 = token('--dsw-alias-border-l3', '#0000001f');
    // `l2` and `l4` are the two the platform's own Settings components use for
    // separators and card edges; both were read off that CSS, not guessed.
    const BORDER_L2 = token('--dsw-alias-border-l2', '#00000014');
    const BORDER_L4 = token('--dsw-alias-border-l4', '#00000029');
    const HOVER_BG = token('--dsw-alias-interactive-bg-hover', '#0000000a');
    const BG_LAYER_1 = token('--dsw-alias-bg-layer-1', '#ffffff');
    const BG_LAYER_2 = token('--dsw-alias-bg-layer-2', '#f5f6f7');
    const BG_LAYER_3 = token('--dsw-alias-bg-layer-3', '#ffffff');
    const SUCCESS = token('--dsw-alias-state-success-primary', '#22c55e');
    const ERROR = token('--dsw-alias-state-error-primary', '#ec1313');
    const WARN = token('--dsw-alias-state-warn-label', '#dd8629');
    const BRAND = token('--dsw-alias-brand-primary', '#4d6bfe');
    const FONT_SECONDARY = 'var(--dsh-content-font-size-secondary, 13px)';

    // ── stylesheet ──────────────────────────────────────────────────────────
    //
    // Injected the way the platform injects its own: one `<style>` carrying a
    // `data-plugin-css` identity, added once. A real stylesheet is not a
    // preference here — the tab strip's hover colour, its active underline and
    // its focus ring are `:hover`, `::after` and `:focus-visible`, none of which
    // an inline `style` object can express.
    //
    // The rules are transcribed from the platform's own Settings components
    // (`ui-settings-plugins`: `PluginsSettingsSection.module.css` for the tab
    // strip and the section frame, `PluginCard.module.css` for the card), with
    // only the class prefix changed. Copying them rather than approximating them
    // is what makes this page stop looking like a guest in its own Settings.
    const CSS_OWNER = 'dsh-workspace-profile/section.css';
    const C = {
      section: 'wsp7k_section',
      head: 'wsp7k_head',
      heading: 'wsp7k_heading',
      card: 'wsp7k_card',
      cardHead: 'wsp7k_cardHead',
      cardTitle: 'wsp7k_cardTitle',
      cardNote: 'wsp7k_cardNote',
      cardBody: 'wsp7k_cardBody',
      badge: 'wsp7k_badge',
      hint: 'wsp7k_hint',
      notice: 'wsp7k_notice',
      noticeWarn: 'wsp7k_noticeWarn',
      noticeError: 'wsp7k_noticeError',
      noticeOk: 'wsp7k_noticeOk',
      noticeNeutral: 'wsp7k_noticeNeutral',
      footer: 'wsp7k_footer',
      discard: 'wsp7k_discard',
      save: 'wsp7k_save',
      control: 'wsp7k_control',
      empty: 'wsp7k_empty',
      pickHead: 'wsp7k_pickHead',
      pickText: 'wsp7k_pickText',
      pickRow: 'wsp7k_pickRow',
      pickLabel: 'wsp7k_pickLabel',
      pickTitle: 'wsp7k_pickTitle',
      pickPath: 'wsp7k_pickPath',
      pickList: 'wsp7k_pickList',
      pickItem: 'wsp7k_pickItem',
      chevron: 'wsp7k_chevron',
      // The section tab strip, and the panel it swaps.
      tabs: 'wsp7k_tabs',
      tab: 'wsp7k_tab',
      tabDot: 'wsp7k_tabDot',
      panelBox: 'wsp7k_panelBox',
      // The skills tab: a two-column grid that fills the tab's height.
      cardGrow: 'wsp7k_cardGrow',
      cardBodyGrow: 'wsp7k_cardBodyGrow',
      gridCell: 'wsp7k_gridCell',
      skillList: 'wsp7k_skillList',
      searchRow: 'wsp7k_searchRow',
      // The availability switch.
      switchBtn: 'wsp7k_switch',
      // The subagents tab: single-column cards, because the official list-of-cards
      // layout is a column and because a Subagent carries a description that a
      // 261px column cannot hold.
      subCard: 'wsp7k_subCard',
      subTop: 'wsp7k_subTop',
      subName: 'wsp7k_subName',
      subKey: 'wsp7k_subKey',
      subRoute: 'wsp7k_subRoute',
      subBottom: 'wsp7k_subBottom',
      subDesc: 'wsp7k_subDesc',
      subActions: 'wsp7k_subActions',
      // The platform's own settings-field layout: label above the control, a
      // hairline between fields. Read off `fields.module.css`, not invented.
      fieldStack: 'wsp7k_fieldStack',
      fieldStackLabel: 'wsp7k_fieldStackLabel',
      fieldStackHint: 'wsp7k_fieldStackHint',
      fieldRow: 'wsp7k_fieldRow',
      routeRow: 'wsp7k_routeRow',
      // The editor modal. Its metrics come from the platform's own settings panel
      // (`VOzbGW_panel` uses bg-layer-2 + `--dsw-elevation-prominent`), which is the
      // modal language this dialog is nested inside.
      modalBackdrop: 'wsp7k_modalBackdrop',
      modalPanel: 'wsp7k_modalPanel',
      modalTitle: 'wsp7k_modalTitle',
    };

    const SECTION_CSS = [
      // The section is a floor-height column so the tab panel can fill it. Without
      // a floor the skills list collapses to its content and we are back to a hard
      // `max-height` guess. `min-height` rather than `height`: content taller than
      // the floor (the first tab) still grows and lets the dialog scroll, instead
      // of being clipped.
      `.${C.section}{display:flex;flex-direction:column;gap:12px;max-width:760px;min-height:min(78vh,700px);` +
        `color:${LABEL_PRIMARY}}`,
      `.${C.head}{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap}`,
      `.${C.heading}{margin:0;font-size:18px;font-weight:600}`,
      // ── the workspace picker, in the header ───────────────────────────────
      //
      // The top-left of the panel *is* the Workspace's identity, so it is also the
      // control that changes it — rather than a heading that names the Workspace
      // plus a separate block that switches it. With tabs below, the other panels
      // no longer repeat the name, so this has to stay visible on every tab.
      `.${C.pickHead}{appearance:none;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;` +
        `border:0;border-radius:10px;padding:4px 8px;margin:-4px -8px;flex:1 1 auto;min-width:0;` +
        `display:flex;align-items:flex-start;gap:8px}`,
      `.${C.pickHead}:hover{background:${HOVER_BG}}`,
      `.${C.pickHead}:focus-visible{outline:2px solid ${BRAND};outline-offset:2px}`,
      `.${C.pickText}{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}`,
      `.${C.pickRow}{display:flex;align-items:center;gap:6px;min-width:0}`,
      `.${C.pickLabel}{color:${LABEL_TERTIARY};font-size:13px;line-height:1.5;flex:none}`,
      `.${C.pickTitle}{color:${LABEL_PRIMARY};font-size:15px;font-weight:600;line-height:1.4;overflow-wrap:anywhere}`,
      `.${C.pickPath}{color:${LABEL_TERTIARY};font-size:12px;line-height:1.5;overflow-wrap:anywhere}`,
      // The indicator is a text glyph (U+25BE), not the platform's SVG, so it has
      // to be sized explicitly: left to inherit, a triangle renders at the body
      // size and reads as a speck rather than as an affordance. The colour stays
      // tertiary, which is what the platform's own card chevron uses.
      `.${C.chevron}{color:${LABEL_TERTIARY};font-size:17px;line-height:1;flex:none;transition:transform .16s}`,
      `.${C.chevron}[data-open=true]{transform:rotate(180deg)}`,
      // `flex-basis:100%` inside the wrapping header row puts the list on its own
      // line, under the trigger, without a second row element to keep in sync.
      `.${C.pickList}{border:.5px solid ${BORDER_L2};border-radius:12px;padding:6px;flex-basis:100%;` +
        `display:flex;flex-direction:column;gap:2px;max-height:300px;overflow-y:auto}`,
      `.${C.pickItem}{appearance:none;width:100%;font:inherit;text-align:left;cursor:pointer;background:0 0;border:0;` +
        `border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:2px;color:inherit}`,
      `.${C.pickItem}:hover{background:${HOVER_BG}}`,
      `.${C.pickItem}[data-active=true]{background:color-mix(in srgb, ${BRAND} 10%, transparent)}`,
      `.${C.pickItem}:focus-visible{outline:2px solid ${BRAND};outline-offset:-2px}`,
      // ── the section tabs ─────────────────────────────────────────────────
      //
      // Transcribed from the platform's own settings tabs
      // (`PluginsSettingsSection.module.css`), only the class prefix changed.
      `.${C.tabs}{border-bottom:.5px solid ${BORDER_L2};align-items:flex-end;gap:22px;display:flex;flex:none}`,
      `.${C.tab}{color:${LABEL_TERTIARY};font:inherit;cursor:pointer;background:0 0;border:0;position:relative;` +
        `padding:7px 1px 9px;font-size:13px;line-height:20px;display:flex;align-items:center;gap:6px}`,
      `.${C.tab}:hover,.${C.tab}[data-active=true]{color:${LABEL_PRIMARY}}`,
      `.${C.tab}[data-active=true]::after,.${C.tab}:focus-visible::after{background:${LABEL_PRIMARY};content:"";` +
        `border-radius:2px 2px 0 0;height:2px;position:absolute;bottom:-1px;left:0;right:0}`,
      `.${C.tab}:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:2px;` +
        `color:${LABEL_PRIMARY};border-radius:2px}`,
      // A dot rather than a label: the staged draft lives on the first tab, and a
      // user reading the skills tab must still be able to tell something is staged.
      // The tab carries the words in its `aria-label`, since a coloured dot says
      // nothing to a screen reader.
      `.${C.tabDot}{width:6px;height:6px;border-radius:50%;background:${WARN};flex:none}`,
      `.${C.panelBox}{flex:1;min-height:0;display:flex;flex-direction:column;gap:10px;padding-top:2px}`,
      // ── the skills tab ───────────────────────────────────────────────────
      //
      // `auto-fill` rather than a hard `repeat(2, …)`: the dialog is not a fixed
      // width, and 320px is the narrowest column that still fits the longest real
      // Skill name (`prc-legal-research-securities-compliance`, 41 chars) beside
      // its switch. Below that the grid falls back to one column by itself, which
      // is the honest degradation — two columns that wrap every long name are worse
      // than one column that does not.
      `.${C.searchRow}{display:flex;align-items:center;gap:10px;flex:none}`,
      // Two columns, because with end-truncation a column only needs ~240px — the
      // measured panel is 531px, and 320px columns could never fit two of them.
      // `auto-fill` still governs: below ~490px it falls back to one column rather
      // than truncating names to nothing.
      // `align-content:start` is load-bearing. Grid's default (`normal`, which
      // behaves as `stretch`) spreads the auto rows across the whole container, so
      // a short list rendered its five rows on an 80px pitch instead of 34 — the
      // cards drifted apart exactly when there were few of them, and the layout
      // changed character with the size of the catalog.
      `.${C.skillList}{flex:1;min-height:180px;overflow-y:auto;display:grid;` +
        `grid-template-columns:repeat(auto-fill,minmax(240px,1fr));column-gap:8px;row-gap:6px;` +
        `align-items:start;align-content:start}`,
      // One line per row, as a bordered card. The name is the only flexible item,
      // so everything else keeps its size and the name truncates — the trade the
      // two-column layout costs, and the reason the state chip shrank to the one
      // word that is not already carried by the dot's colour.
      `.${C.gridCell}{min-width:0;display:flex;align-items:center;gap:6px;padding:6px 9px;` +
        `border:.5px solid ${BORDER_L4};border-radius:10px;background:${BG_LAYER_3}}`,
      `.${C.gridCell}:hover{border-color:var(--dsw-alias-label-dimmed, ${LABEL_TERTIARY})}`,
      // ── the availability switch ──────────────────────────────────────────
      //
      // Three things have to be distinguishable at a glance: on, off, and
      // *not-touchable* (a bundled Skill). Off is a solid ring; not-touchable is a
      // washed-out one — so "I turned this off" and "this is not mine to turn off"
      // do not look the same.
      `.${C.switchBtn}{appearance:none;flex:none;width:16px;height:16px;padding:0;margin:3px 0 0;` +
        `border-radius:50%;border:1.5px solid ${ERROR};background:0 0;cursor:pointer;` +
        `transition:background .16s,border-color .16s}`,
      // Colour carries the state for the Skills a user can actually change: green
      // filled is on, red ring is off. Shape alone (filled vs hollow) was not read
      // as a state at a glance.
      `.${C.switchBtn}[aria-checked=true]{border-color:${SUCCESS};background:${SUCCESS}}`,
      `.${C.switchBtn}:hover:not(:disabled){box-shadow:0 0 0 3px ${HOVER_BG}}`,
      `.${C.switchBtn}:focus-visible{outline:2px solid ${BRAND};outline-offset:2px}`,
      // Grey, not coloured: a bundled Skill's state is not something the user set,
      // and colouring it would invite a click that cannot do anything.
      `.${C.switchBtn}:disabled{cursor:not-allowed;opacity:.4;border-color:${LABEL_TERTIARY};background:0 0}`,
      `.${C.switchBtn}:disabled[aria-checked=true]{background:${LABEL_TERTIARY}}`,
      // ── the subagents tab ────────────────────────────────────────────────
      //
      // One card per Subagent, in a column. The official settings list is a column
      // of cards (`PluginCard`'s `.cards{flex-direction:column;gap:10px}`), and a
      // Subagent carries a description that the skills grid's 261px column cannot
      // hold — so this tab does not copy the skills grid.
      `.${C.subCard}{border:.5px solid ${BORDER_L4};background:${BG_LAYER_3};border-radius:12px;` +
        `padding:10px 12px;display:flex;flex-direction:column;gap:6px}`,
      `.${C.subTop}{display:flex;align-items:center;gap:8px;min-width:0}`,
      // 15px/600 with line-height 1.4 is the platform's own card `.name`.
      `.${C.subName}{flex:0 1 auto;min-width:0;font-size:15px;font-weight:600;line-height:1.4;` +
        `color:${LABEL_PRIMARY};overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
      // Monospace because the key is an identifier — it is what the model passes to
      // `workspace_subagent`, so it has to read as one rather than as prose.
      `.${C.subKey}{flex:0 1 auto;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;` +
        `font-size:11px;line-height:1.5;color:${LABEL_TERTIARY};background:${BG_LAYER_2};` +
        `border-radius:6px;padding:1px 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
      `.${C.subRoute}{margin-left:auto;flex:none;font-size:11px;line-height:1.5;color:${LABEL_TERTIARY};white-space:nowrap}`,
      `.${C.subBottom}{display:flex;align-items:center;gap:10px;min-width:0}`,
      // The platform's card `.description`: 13px, tertiary, line-height 1.5.
      `.${C.subDesc}{flex:1 1 auto;min-width:0;font-size:13px;line-height:1.5;color:${LABEL_TERTIARY};` +
        `overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
      `.${C.subActions}{flex:none;display:flex;align-items:center;gap:6px}`,
      // The platform's secondary button, at the size this row can afford.
      `.${C.subActions} button{appearance:none;font:inherit;font-size:12px;line-height:1.5;cursor:pointer;` +
        `background:0 0;border:1px solid ${BORDER_L2};border-radius:8px;padding:3px 10px;color:${LABEL_SECONDARY}}`,
      `.${C.subActions} button:hover:not(:disabled){color:${LABEL_PRIMARY};` +
        `border-color:var(--dsw-alias-label-dimmed, ${LABEL_TERTIARY})}`,
      `.${C.subActions} button:disabled{opacity:.4;cursor:default}`,
      `.${C.subActions} button:focus-visible{outline:2px solid ${BRAND};outline-offset:1px}`,
      // ── the editor dialog's fields ───────────────────────────────────────
      //
      // Transcribed from the platform's `fields.module.css`: the label sits above
      // its control, and consecutive fields are separated by a hairline. The old
      // 132px left-hand label column is not a layout the platform uses, and it spent
      // a quarter of the dialog on labels.
      // One rhythm for the whole dialog: every group carries 10px above and below,
      // so every boundary between two of them is 20px with the hairline down the
      // middle, and the label sits 6px above its control. 10px rather than the
      // platform's 12px because at 12px this six-field form measured 694px in a
      // 681px panel and had to scroll; see the footer rule.
      `.${C.fieldStack}{display:flex;flex-direction:column;gap:6px;padding:10px 0}`,
      // The hairline belongs to "a group that follows another one", not to
      // "a fieldStack that follows a fieldStack": the first group here is the
      // name/key `.fieldRow`, so the route group under it matched nothing and was
      // the one group in the dialog with no separator. Selecting on the panel's
      // children instead covers every ordering.
      `.${C.modalPanel}>*+.${C.fieldStack},.${C.modalPanel}>*+.${C.fieldRow}{border-top:.5px solid ${BORDER_L2}}`,
      // `flex:none`, and it matters more than it looks. This was `flex:1`, carried
      // over from the old 132px left-hand label column where growing along the row
      // is what you want. Stacked above the control, the flex axis is vertical, so
      // `flex:1` (`flex-basis:0`) makes the label swallow the column's leftover
      // height: in the name/key row the key column also holds a hint, so the name
      // label grew to 43.5px against the key label's 19.5px and pushed its input
      // 24px below the key input. Two fields on one line, visibly out of line.
      `.${C.fieldStackLabel}{min-width:0;flex:none;color:${LABEL_PRIMARY};font-size:13px;font-weight:500;line-height:1.5}`,
      // `text-wrap:pretty` so a hint that has to wrap does not leave one short word on
      // the second line — the key hint's "的。" was doing exactly that and made the
      // name/key row 18px taller than its neighbour for no information.
      `.${C.fieldStackHint}{color:${LABEL_TERTIARY};margin:0;font-size:12px;line-height:1.5;` +
        `text-wrap:pretty}`,
      // Two fields side by side (name / key), three for the route. `minmax(0,1fr)`
      // rather than `1fr`: a grid track's automatic minimum is its content, so a
      // long model id would otherwise push the row wider than the dialog.
      // `padding:12px 0` on the row itself as well as on `.fieldStack`, because a
      // row is a field group too. Every vertical boundary in this dialog is then
      // the same 24px (12px out + 12px in) with the hairline in the middle of it:
      // the title, the five groups and the footer all sit on one rhythm.
      `.${C.fieldRow}{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:10px 0}`,
      `.${C.routeRow}{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}`,
      // Inside a row the fields keep no vertical padding of their own: the row is
      // one field group, so it owns the 12px and the hairline above it. These
      // nested stacks cannot match the panel-child separator rule above, so unlike
      // the old `.fieldStack+` version they need no `border-top:0` rescue.
      `.${C.fieldRow} > .${C.fieldStack},.${C.routeRow} > .${C.fieldStack}{padding:0}`,
      // Controls share the row evenly instead of the fixed 180–320px band that was
      // sized for a one-field-per-line form.
      `.${C.fieldStack} select,.${C.fieldStack} input{min-width:0;max-width:none;width:100%}`,
      // The switch carries `margin-top:3px` so it sits optically centred in a list
      // row. Stacked under a label it is a control like any other, so it has to
      // start where one starts: measured 9px below its label against the 6px that
      // every input, select and textarea in this dialog uses.
      `.${C.fieldStack} .${C.switchBtn}{margin-top:0}`,
      `.${C.modalBackdrop}{position:fixed;inset:0;background:var(--dsw-alias-bg-mask-1,#00000066);` +
        `display:flex;align-items:center;justify-content:center;z-index:60;padding:24px}`,
      // `max-height:100%` resolves against the backdrop's padding box, so the panel
      // can never outgrow the window — and because the Settings dialog it is nested
      // in is `overflow:hidden`, it can never be clipped by that either.
      //
      // `box-sizing:border-box` is what makes that true. `max-height` applies to the
      // content box, so with the default `content-box` the panel's own 36px of
      // padding sat *outside* the limit: measured against a 681px padding box the
      // panel laid out at 717px and came within 6px of the viewport edge instead of
      // the 24px the backdrop asks for. Measured with a 2000px child: 717px tall,
      // 6px from the top. With border-box the same child clamps to 681px, 24px.
      `.${C.modalPanel}{box-sizing:border-box;width:100%;max-width:640px;max-height:100%;overflow-y:auto;` +
        `background:${BG_LAYER_2};border-radius:20px;` +
        `box-shadow:var(--dsw-elevation-prominent,0 12px 40px #00000033);padding:20px 20px 0;` +
        `display:flex;flex-direction:column}`,
      // Six fields, two of them textareas, on one rhythm: this form is tall enough
      // to run out of a 729px window, and the panel scrolls when it does. The
      // buttons are the one part that must not scroll away with the fields above
      // them, so the footer sticks to the bottom of the scrollport and paints the
      // panel's own background — without it the fields would show through as they
      // passed underneath. Its own `padding-bottom` replaces the panel's, which is
      // 0 for exactly this reason.
      //
      // Sticky is a floor, not the plan. Measured at a 729px viewport the panel is
      // 668px against a 681px cap, so nothing scrolls and the switch is never left
      // half-hidden behind the footer. The `padding:10px 0` below is what buys that:
      // at the platform's own 12px the content came to 694px and the 启用 switch sat
      // 15px under the footer at rest.
      `.${C.modalPanel}>.${C.footer}{position:sticky;bottom:0;background:${BG_LAYER_2};` +
        `padding:10px 0 16px}`,
      // `padding-bottom:10px` rather than `margin-bottom`: the first field group
      // already carries 10px of its own, so this makes the title-to-first-field
      // boundary the same 20px as every boundary below it. No hairline there —
      // a heading belongs to what follows it and should not be fenced off.
      `.${C.modalTitle}{margin:0;padding:0 0 10px;font-size:15px;font-weight:600;line-height:1.5;` +
        `color:${LABEL_PRIMARY}}`,
      // The card, verbatim from the platform's own settings cards.
      `.${C.card}{border:.5px solid ${BORDER_L4};background:${BG_LAYER_3};border-radius:16px;flex:none}`,
      `.${C.cardHead}{display:flex;align-items:center;gap:12px;padding:14px 16px}`,
      `.${C.cardTitle}{margin:0;flex:1;min-width:0;font-size:15px;font-weight:600;line-height:1.4;color:${LABEL_PRIMARY}}`,
      `.${C.cardNote}{color:${LABEL_TERTIARY};font-size:12px;line-height:1.5;margin:0}`,
      `.${C.cardBody}{border-top:.5px solid ${BORDER_L2};margin:0 16px;padding:12px 0 14px;` +
        `display:flex;flex-direction:column;gap:10px}`,
      // A card that fills its panel and hands the leftover height to its body, so
      // the skills list scrolls inside the card instead of the whole dialog.
      `.${C.cardGrow}{flex:1;min-height:0;display:flex;flex-direction:column}`,
      `.${C.cardBodyGrow}{flex:1;min-height:0;overflow:hidden}`,
      `.${C.badge}{font-size:12px;line-height:1.5;color:${LABEL_TERTIARY};flex:none}`,
      `.${C.hint}{color:${LABEL_TERTIARY};margin:0;font-size:12px;line-height:1.5}`,
      `.${C.notice}{border-radius:10px;padding:8px 12px;font-size:13px;line-height:1.5}`,
      `.${C.noticeWarn}{background:color-mix(in srgb, ${WARN} 12%, transparent);color:${WARN}}`,
      `.${C.noticeError}{background:color-mix(in srgb, ${ERROR} 12%, transparent);color:${ERROR}}`,
      `.${C.noticeOk}{background:color-mix(in srgb, ${SUCCESS} 12%, transparent);color:${SUCCESS}}`,
      `.${C.noticeNeutral}{background:color-mix(in srgb, ${LABEL_SECONDARY} 12%, transparent);color:${LABEL_SECONDARY}}`,
      `.${C.empty}{color:${LABEL_TERTIARY};margin:0;font-size:13px;padding:12px 0}`,
      // `margin-top:auto` keeps the save bar at the bottom of the first tab however
      // short its content is, so switching tabs does not move it.
      `.${C.footer}{display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;` +
        `border-top:.5px solid ${BORDER_L2};flex:none;margin-top:auto}`,
      `.${C.discard},.${C.save}{appearance:none;font:inherit;font-size:13px;line-height:1.5;cursor:pointer;` +
        `border-radius:8px;padding:5px 14px;border:1px solid transparent}`,
      `.${C.discard}{border-color:${BORDER_L2};color:${LABEL_SECONDARY};background:0 0}`,
      `.${C.discard}:hover:not(:disabled){color:${LABEL_PRIMARY}}`,
      `.${C.save}{background:${BRAND};color:var(--dsw-alias-label-primary-inverted,#fff)}`,
      `.${C.discard}:disabled,.${C.save}:disabled{opacity:.5;cursor:not-allowed}`,
      // Form controls, to the platform's own input metrics.
      `.${C.control}{font:inherit;font-size:13px;line-height:1.5;color:${LABEL_PRIMARY};background:${BG_LAYER_3};` +
        `border:.5px solid ${BORDER_L4};border-radius:8px;padding:0 12px;height:34px;min-width:180px;max-width:320px}`,
      `select.${C.control}{height:34px;padding:0 8px}`,
      `.${C.control}:focus-visible{border-color:${BRAND};outline:none}`,
    ].join('');

    if (typeof document !== 'undefined') {
      const selector = 'style[data-plugin-css=' + JSON.stringify(CSS_OWNER) + ']';
      const existing = document.querySelector(selector);
      if (!existing) {
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-workspace-profile';
        tag.dataset.pluginCss = CSS_OWNER;
        tag.textContent = SECTION_CSS;
        document.head.appendChild(tag);
      } else if (existing.textContent !== SECTION_CSS) {
        // Editing this stylesheet and having nothing change is the worst kind of
        // confusing: the module hot-reloads, the markup updates, and the old rules
        // stay applied because a previous version already added the tag. Replacing
        // the text is what makes a stylesheet edit observable without a hard reload.
        existing.textContent = SECTION_CSS;
      }
    }

    const s = {
      field: { display: 'flex', alignItems: 'center', gap: 10, minHeight: 28 },
      fieldLabel: { width: 132, flex: '0 0 132px', fontSize: FONT_SECONDARY, color: LABEL_SECONDARY },
      fieldValue: { flex: 1, minWidth: 0, fontSize: FONT_SECONDARY },
      // The inline counterpart of the stylesheet's card class. The notices,
      // hints and empty states keep their own definitions further down, which
      // predate the stylesheet and are still referenced from state-dependent
      // call sites.
      // Form controls follow the platform's own input metrics, so a select here
      // is the same height and radius as a select anywhere else in Settings.
      select: {
        font: 'inherit', fontSize: FONT_SECONDARY, color: LABEL_PRIMARY, background: BG_LAYER_3,
        border: '0.5px solid ' + BORDER_L4, borderRadius: 8, padding: '0 8px', height: 34,
        minWidth: 180, maxWidth: 320,
      },
      input: {
        font: 'inherit', fontSize: FONT_SECONDARY, color: LABEL_PRIMARY, background: BG_LAYER_3,
        border: '0.5px solid ' + BORDER_L4, borderRadius: 8, padding: '0 12px', height: 34,
        width: '100%', boxSizing: 'border-box',
      },
      textarea: {
        font: 'inherit', fontSize: FONT_SECONDARY, color: LABEL_PRIMARY, background: BG_LAYER_3,
        border: '0.5px solid ' + BORDER_L4, borderRadius: 8, padding: '6px 12px', width: '100%',
        boxSizing: 'border-box', minHeight: 56, resize: 'vertical', lineHeight: '19px',
      },
      hint: { fontSize: 11, color: LABEL_TERTIARY, lineHeight: '16px' },
      // No width cap: the field sits above a full-width list, and a capped box on a
      // panel this wide reads as a leftover rather than as a search field.
      search: { flex: '1 1 auto', minWidth: 0 },
      button: {
        font: 'inherit', fontSize: FONT_SECONDARY, color: LABEL_PRIMARY, background: 'transparent',
        border: '0.5px solid ' + BORDER_L2, borderRadius: 8, padding: '5px 14px', cursor: 'pointer', lineHeight: '1.5',
        // A button's label is the button. Without these two the flex algorithm
        // treats it as shrinkable like any other item, so a crowded row crushes
        // 编辑 into 编/辑 on two lines — which reads as a rendering fault rather
        // than as a layout that ran out of room. Refusing to shrink makes the row
        // wrap instead, which is the honest failure.
        whiteSpace: 'nowrap', flexShrink: 0,
      },
      buttonPrimary: {
        font: 'inherit', fontSize: FONT_SECONDARY, color: token('--dsw-alias-label-primary-inverted', '#ffffff'),
        background: BRAND, border: '0.5px solid transparent', borderRadius: 8, padding: '4px 12px',
        cursor: 'pointer', lineHeight: '18px', whiteSpace: 'nowrap', flexShrink: 0,
      },
      buttonDisabled: { opacity: 0.5, cursor: 'not-allowed' },
      row: {
        display: 'flex', alignItems: 'center', gap: 8, rowGap: 6, flexWrap: 'wrap', padding: '5px 10px',
        borderRadius: 10, fontSize: FONT_SECONDARY, minHeight: 28,
      },
      // The floor is the point: `overflowWrap: anywhere` on a zero-width flex item
      // breaks a name one character per line, which is what 高级顾问 did before
      // this. A name is the row's identity and must stay readable; the row wraps
      // around it rather than crushing it.
      // The flexible item: it takes the slack and truncates. `min-width: 0` is what
      // lets a flex item shrink below its content; without it the row overflows.
      rowName: { flex: '1 1 auto', minWidth: 0 },
      pill: (colour) => ({
        fontSize: 11, padding: '1px 8px', borderRadius: 999, fontWeight: 500, whiteSpace: 'nowrap',
        color: colour, background: 'color-mix(in srgb, ' + colour + ' 12%, transparent)',
      }),
      notice: (colour) => ({
        fontSize: FONT_SECONDARY, color: colour, background: 'color-mix(in srgb, ' + colour + ' 10%, transparent)',
        borderRadius: 8, padding: '6px 10px', lineHeight: '19px', whiteSpace: 'pre-wrap',
      }),
      empty: { fontSize: FONT_SECONDARY, color: LABEL_TERTIARY, padding: '6px 10px' },
      // The injection preview. Preformatted because this is a *prompt*, not
      // prose: its line breaks and heading levels are part of what the model
      // receives, so reflowing it would show something the model never sees.
      previewText: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, lineHeight: '18px',
        whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: LABEL_PRIMARY,
        background: BG_LAYER_1, border: '0.5px solid ' + BORDER_L2, borderRadius: 8,
        padding: '8px 10px', margin: 0, maxHeight: 240, overflow: 'auto',
      },
      previewHead: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
      previewGroup: { display: 'flex', flexDirection: 'column', gap: 8 },
      previewSection: { display: 'flex', flexDirection: 'column', gap: 4 },
    };

    // ── Subagent templates ──────────────────────────────────────────────────
    /**
     * Factory presets for the 添加子 Agent dialog.
     *
     * Each entry pre-fills the create form; it is **not** a stored definition.
     * Nothing here carries an `id`: the Host assigns ids, and a template that
     * arrived with one would turn every "create from template" into an edit of
     * the same Subagent. `reasoningEffort` is likewise a suggestion — the route
     * is preflighted live in the dialog, so a model that has gone away reports
     * itself instead of being silently substituted.
     *
     * `description` is copied from the owner's own wording, never paraphrased:
     * it is the line the model reads when choosing an agent, so a rewrite here
     * would quietly change whom the dispatcher picks.
     *
     * ## Three shapes of route, and why `model` is not always a model id
     *
     * - a **fixed route** (`provider` + `model`) is written down, for the agents
     *   whose model is a deliberate product decision;
     * - a **backend with no DSH route at all** (`backend: 'codex'`) writes
     *   neither, because Codex chooses its own model from its own configuration;
     * - a **model spec** (`modelSpec`, e.g. "GPT-6.1 Sol") is looked up in the
     *   live catalog when the template is applied. The real `provider`/`model`
     *   ids of a model whose name the plan gives in prose are **not** knowable
     *   from source, and hard-coding a guess would produce a template that fails
     *   its own preflight. If the catalog does not answer with exactly one
     *   candidate for the spec, the template fills nothing and leaves the route
     *   empty for the user to choose — silently, because 0.6.0 removed the notice
     *   that used to explain the failed match.
     *
     * Module-level and exported on purpose. The create dialog only renders while
     * it is open, and the browser test harness builds a static tree, so a
     * template's correctness cannot be observed through that tree — it can be
     * observed here, where it is data.
     *
     * @type {ReadonlyArray<{ id: string, label: string, key: string, name: string, description: string, backend: string, provider?: string, model?: string, modelSpec?: string, reasoningEffort?: string, instructions: string }>}
     */
    const SUBAGENT_TEMPLATES = [
      {
        id: 'reviewer',
        label: '独立评审员',
        key: 'reviewer',
        name: '独立评审员',
        backend: 'spawn',
        description: '以外部身份独立评审法律观点或法律文书：不预设原结论正确，主动寻找反例与漏洞，指出依据不足之处，并区分「已查明事实／主张／推断／未知」。',
        provider: 'kimi-coding',
        model: 'k3',
        reasoningEffort: 'max',
        instructions: '',
      },
      {
        id: 'assist',
        label: '律师助理',
        key: 'assist',
        name: '律师助理',
        backend: 'spawn',
        description: '承担整理文件、摘要、时间线、当事人信息整理、初步问题识别，以及格式、表格、数据转换与普通检索等大批量重复任务。',
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        reasoningEffort: 'max',
        instructions: '',
      },
      {
        id: 'coding',
        label: '码农',
        key: 'coding',
        name: '码农',
        backend: 'spawn',
        // The duties are the owner's own list, enumerated rather than collapsed
        // into "write code": this line is read when deciding whether a request
        // belongs to this agent, and a summary would hide repository analysis
        // and DSH-plugin work behind the same two words.
        description: '阅读并分析代码仓库；定位、复现并修复 Bug；编写或修改代码；编写脚本；修改工程配置；编写、运行并修复测试；重构；分析依赖、接口与实现机制；承接 DSH 插件及其他工程开发任务。',
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        reasoningEffort: 'max',
        instructions: '',
      },
      {
        id: 'code-expert',
        label: '代码专家',
        key: 'code-expert',
        name: '代码专家',
        // The Codex backend. No `provider`, no `model`, no `reasoningEffort`:
        // those are DSH LLM route fields, and a Codex child's model comes from
        // the Codex provider's own configuration. Writing a guess here would
        // either be ignored or, worse, be enforced.
        backend: 'codex',
        description: '在真实代码仓库中完成工程任务：多文件实现、复杂 Bug 定位与修复、DSH 插件开发、CLI/MCP/Skill 开发、测试编写与执行、重构、构建错误处理、依赖与接口实现。',
        instructions: '',
      },
      {
        id: 'code-architect',
        label: '代码架构师',
        key: 'code-architect',
        name: '代码架构师',
        backend: 'spawn',
        description: '以分析、设计和审查为主：系统架构设计、模块边界判断、复杂技术方案比较、根因分析、跨模块问题、大规模重构前设计、Codex 实现结果复核、技术债与兼容性分析、疑难问题的第二意见。',
        // The plan names this model in prose ("GPT-6.1 Sol", high effort). Its
        // real `provider/model` ids are resolved from the live catalog when the
        // template is applied — see `resolveTemplateRoute`. Nothing here guesses
        // them, and nothing falls back to a different GPT.
        modelSpec: 'GPT-6.1 Sol',
        reasoningEffort: 'high',
        instructions: '',
      },
    ];

    /**
     * Normalize a model name for comparison.
     *
     * Case, spaces, hyphens, underscores and dots are dropped, so `GPT-6.1 Sol`,
     * `gpt-6.1-sol` and `GPT 6.1 Sol` are the same spec. Nothing else is: a
     * prefix or fuzzy match would let `GPT-6.1-Sol-Mini` satisfy a request for
     * `GPT-6.1 Sol`, and quietly running the architect's work on a different
     * model is exactly what the plan forbids.
     *
     * @param {unknown} value - a name or id.
     * @returns {string} the comparison form, `''` for a non-string.
     */
    function normalizeModelSpec(value) {
      return typeof value === 'string' ? value.toLowerCase().replace(/[\s._-]+/g, '') : '';
    }

    /**
     * Every catalog entry whose display name or id is the requested spec.
     *
     * @param {any} catalog - the `models()` answer, or `null` before it lands.
     * @param {string} spec - the requested model, as the plan spells it.
     * @returns {Array<{ provider: string, model: string, entry: any }>} the matches.
     */
    function matchModelSpec(catalog, spec) {
      const wanted = normalizeModelSpec(spec);
      if (wanted === '') return [];
      const providers = (catalog && catalog.providers) || [];
      const out = [];
      for (const provider of providers) {
        for (const entry of provider.models || []) {
          if (normalizeModelSpec(entry.id) === wanted || normalizeModelSpec(entry.name) === wanted) {
            out.push({ provider: provider.provider, model: entry.id, entry });
          }
        }
      }
      return out;
    }

    /**
     * Resolve a template's model spec against the live catalog.
     *
     * The rule the plan sets out, implemented literally: **only a unique match
     * that supports the requested effort is filled in**. Everything else returns
     * the reason to its caller instead of a route, so the user picks from the real
     * catalog rather than being handed a plausible-looking route that fails its own
     * preflight. The reason is **data**: the dialog no longer renders it — the
     * failed-match notice was removed at the owner's request (CHANGELOG 0.6.0) —
     * but the verdict stays observable here and in the tests.
     *
     * @param {any} catalog - the `models()` answer, or `null` when unavailable.
     * @param {string} spec - the requested model name.
     * @param {string} [effort] - the requested reasoning effort, when the template names one.
     * @returns {{ ok: true, provider: string, model: string, reasoningEffort: string }
     *   | { ok: false, reason: 'no-catalog'|'not-found'|'ambiguous'|'no-effort', candidates: string[] }}
     *   the verdict.
     */
    function resolveTemplateRoute(catalog, spec, effort) {
      if (catalog === null || catalog === undefined || catalog.available === false) {
        return { ok: false, reason: 'no-catalog', candidates: [] };
      }
      const matches = matchModelSpec(catalog, spec);
      if (matches.length === 0) return { ok: false, reason: 'not-found', candidates: [] };
      if (matches.length > 1) {
        return {
          ok: false,
          reason: 'ambiguous',
          candidates: matches.map((match) => match.provider + '/' + match.model),
        };
      }
      const [match] = matches;
      if (typeof effort === 'string' && effort !== '') {
        const efforts = (match.entry.efforts || []).map((entry) => entry.id);
        if (!efforts.includes(effort)) {
          return { ok: false, reason: 'no-effort', candidates: [match.provider + '/' + match.model] };
        }
      }
      return {
        ok: true,
        provider: match.provider,
        model: match.model,
        reasoningEffort: typeof effort === 'string' ? effort : '',
      };
    }

    /**
     * The patch a template contributes to the create form.
     *
     * A full overwrite of the fields a template owns, not a merge: picking a
     * template is a deliberate act, and quietly keeping a field from whatever was
     * typed before would produce a Subagent that is neither the template nor the
     * user's own text. Empty string is a real value — the templates carry empty
     * `instructions`, and "this template adds no extra guidance" has to be
     * sayable rather than silently meaning "keep the old text".
     *
     * `enabled` is deliberately absent: whether a new agent starts enabled is the
     * user's answer, not a preset's. `id` is absent for the same class of reason —
     * the Host assigns it, and an edit must never be the result of "create from
     * template".
     *
     * A template with a `modelSpec` and no unique catalog match fills **nothing**
     * into the route: see {@link resolveTemplateRoute}. That is the plan's red
     * line — 不猜、不 fallback 到其他 GPT、不偷偷改模型.
     *
     * @param {{ key: string, name: string, description: string, backend?: string, provider?: string, model?: string, modelSpec?: string, reasoningEffort?: string, instructions: string }} template - one entry of {@link SUBAGENT_TEMPLATES}.
     * @param {any} [catalog] - the live `models()` catalog, for templates whose route must be resolved.
     * @returns {{ backend: string, key: string, name: string, description: string, provider: string, model: string, reasoningEffort: string, instructions: string }} the form patch.
     */
    function templateFormPatch(template, catalog) {
      const backend = template.backend === 'codex' ? 'codex' : 'spawn';
      /** @type {{ provider: string, model: string, reasoningEffort: string }} */
      let route = { provider: template.provider || '', model: template.model || '', reasoningEffort: template.reasoningEffort || '' };
      if (backend === 'spawn' && typeof template.modelSpec === 'string') {
        const resolved = resolveTemplateRoute(catalog ?? null, template.modelSpec, template.reasoningEffort);
        route = resolved.ok
          ? { provider: resolved.provider, model: resolved.model, reasoningEffort: resolved.reasoningEffort }
          : { provider: '', model: '', reasoningEffort: '' };
      }
      return {
        backend,
        key: template.key,
        name: template.name,
        description: template.description,
        provider: route.provider,
        model: route.model,
        reasoningEffort: route.reasoningEffort,
        instructions: template.instructions,
      };
    }

    // ── copy ────────────────────────────────────────────────────────────────
    const DICTS = {
      zh: {
        nav: '工作区',
        title: '工作区',
        workspaces: '工作区',
        chooseWorkspace: '选择工作区',
        workspaceLabel: '工作区 ·',
        tabWorkspace: '工作区配置',
        tabSkills: '可用技能',
        tabSubagents: '子代理配置',
        shownOfTotal: '显示',
        totalOf: '共',
        noWorkspaces: '还没有任何工作区。先在侧栏新建一个工作区，再回到这里配置。',
        configured: '已配置',
        unconfigured: '未配置',
        configuredNoProfile: '这个工作区已经保存过配置（例如 Skills 启停），但还没有选择 Profile 与默认视角。',
        skipped: '已跳过',
        blockType: '工作区类型（保存后生效）',
        profile: '类型（Profile）',
        perspective: '默认视角',
        blockNorms: '配置文件与生效状态',
        blockNormsHint: '以上为**已保存**并在会话中生效的内容。「已发现」只表示文件存在，插件不解析也不覆盖它；AGENTS 与权限规则始终优先于本页配置。',
        pendingEdits: '上方有未保存的修改，尚未生效——保存后才会注入会话。',
        injectionOn: '已注入',
        injectionOff: '未注入',
        injectionOffNoProfile: '这个工作区还没有选择 Profile，因此 Profile 与立场都不会写入系统提示词。只保存过 Skills 启停不会注入任何内容。',
        injectionOffSkipped: '这个工作区被标记为「已跳过」，不会写入任何工作区内容。',
        injectionNone: '这个工作区不会向系统提示词写入任何内容。',
        injectionNeedsRestart: '宿主还没有重启：预览方法是 0.1.2 新增的，客户端已经热更新，但宿主进程仍是旧的。重启 DSH 后重新打开本页即可。',
        viewInjection: '查看注入的提示词',
        view: '查看',
        injectionTitle: '注入的提示词',
        injectionStoredTitle: '一、当前已保存（会话中正在使用）',
        injectionDraftTitle: '二、保存后将是',
        injectionDirty: '上方表单有未保存的改动。下面显示的是「已保存」的内容 —— 保存后才会变成新选择的样子。',
        injectionDraftInvalid: '草稿无效，无法预览：',
        injectionNotLoaded: 'Profile 正文尚未加载完成，这次显示可能不完整；稍后重试即可。',
        matterTitle: '案件（Matter）',
        matterHint: '以上由工作区目录中的 matter.yaml 读出，本页只读。插件不会因为你改了 Profile 就回写案件文件，也不会因为案件文件变了就自动改你的配置。',
        matterNone: '这个目录下没有 matter.yaml —— 普通项目目录就是这样，不是错误。',
        matterNoneMulti: '工作区声明的这些目录下都没有 matter.yaml：',
        matterUnreadable: '发现了 matter.yaml，但无法读取：',
        matterName: '名称',
        matterRoot: '案件目录',
        matterId: 'Matter ID（案件标识）',
        matterType: '类型',
        matterRole: '正式角色',
        matterStage: '程序阶段',
        matterModules: '模块',
        matterMatch: '一致',
        matterMismatch: '不一致',
        matterOverride: '本次会话覆盖',
        matterUnknown: '未知',
        matterProfileMatch: '类型与工作区配置',
        matterPerspectiveMatch: '正式角色与默认视角',
        matterApplyHint: '会写入 Profile 与默认视角，保存后生效。',
        injectionUnavailable: '无法显示注入内容：',
        injectionLoadFailed: '读取注入内容失败',
        injectionOverrideNote: '这里是「工作区默认」立场。会话内用 `/perspective` 做的临时覆盖不会出现在这里。',
        injectionEmptySection: '（本段为空 —— 不会写入系统提示词）',
        injectionChars: '字符',
        injectionCopy: '复制全文',
        injectionCopied: '已复制',
        injectionClose: '关闭',
        injectionSectionContext: '工作区 Profile',
        injectionSectionPerspective: '工作立场',
        injectionSectionAgents: '专家 Subagent 目录',
        globalAgents: '全局 AGENTS.md',
        projectAgents: '项目 AGENTS.md',
        found: '已发现',
        notFound: '未发现',
        blockSkills: '可用技能',
        skillsSearch: '搜索 Skill',
        skillCountUnit: '项',
        skillsEmpty: '没有可显示的 Skill。',
        skillsUnavailable: '当前部署没有挂载 skills 服务，无法列出 Skill。',
        recommendedTag: '推荐',
        disabledTag: '已禁用',
        missingTag: '未安装',
        readonlyTag: '只读',
        missingSkills: '推荐但未安装',
        stateRecommended: '推荐',
        stateEnabled: '可用',
        stateDisabled: '禁用',
        recommendedByProfile: '类型推荐',
        recommendedByWorkspace: '本区推荐',
        recommendedByProfileHint: '由工作区类型推荐：该类型的所有工作区都会推荐这个 Skill。',
        recommendedByWorkspaceHint: '由本工作区单独推荐，只影响这个工作区。',
        skillStateLabel: 'Skill 状态',
        perspectiveHint: '工作立场可在会话中用 /perspective 临时切换，只影响当前会话，不会修改这里的默认值。',
        perspectiveNone: '该工作区类型没有可选的工作立场。',
        blockSubagents: '子代理配置',
        noSubagents: '还没有配置子 Agent。',
        addSubagent: '添加子 Agent',
        edit: '编辑',
        disable: '禁用',
        enable: '启用',
        duplicate: '复制',
        remove: '删除',
        save: '保存',
        saving: '保存中…',
        discard: '放弃更改',
        unsaved: '有未保存的更改',
        reload: '重新加载',
        copyDraft: '复制当前编辑内容',
        copied: '已复制到剪贴板',
        addTitle: '新建子 Agent',
        editTitle: '编辑子 Agent',
        fName: '名称',
        fKey: '标识（Key）',
        fTemplate: '模板',
        templateNone: '不用模板 —',
        templateHint: '选中即填入下列字段，保存前都可以改。模板只是建议值，不会替你保存。',
        // Only the resolved case still has a notice. A spec that matched nothing,
        // matched twice, or matched a model without the requested effort fills no
        // route and says nothing: the owner asked for that explanation to be
        // removed (CHANGELOG 0.6.0), and the empty Provider / Model selects are
        // the whole story — the user picks from the real catalog there.
        templateModelResolved: '已按实时模型目录填入：',
        fBackend: '执行方式',
        backendSpawn: 'DSH 子代理',
        backendCodex: 'Codex',
        backendHint: 'DSH 子代理走本部署的模型路由（提供方 / 模型 / 推理强度）。Codex 使用官方 Codex 后端，模型跟随 Codex 原生配置，本插件不接管。',
        backendNoteTitle: '执行后端',
        backendNoteCodex: '模型：跟随 Codex 原生配置',
        backendNoteSpawn: '模型：本部署的模型路由（见下方）',
        codexAvailable: 'Codex 后端可用',
        codexMissing: 'Codex 后端未安装',
        codexMissingHint: '本部署没有注册 Codex 子代理后端。插件不会自动安装、也不会改用 DSH 子代理或换模型；保存后调用会直接报错说明原因。',
        codexProblem: 'Codex 后端检测失败：',
        fRoute: '模型路由（Route）',
        fProvider: '提供方',
        fModel: '模型',
        fEffort: '推理强度',
        fDescription: '职责描述',
        fInstructions: '补充工作指引',
        fEnabled: '启用',
        effortDefault: '（模型默认）',
        keyHint: '创建后不可修改。只能用小写字母、数字和连字符。',
        keyLocked: '创建后不可修改。要换 key，请复制为新定义再删除旧的。',
        descHint: '一句话职责。它会进入模型可见的专家目录，请写清"做什么"。',
        instructionsHint: '可选的补充要求，不保存案件事实。',
        cancel: '取消',
        create: '创建',
        routeChecking: '正在校验模型路由…',
        routeOk: '模型路由可用',
        routeBad: '模型路由不可用',
        deleteConfirm: '删除这个子 Agent 定义？删除后无法恢复。',
        orphanTitle: '孤立的配置（工作区已不存在）',
        orphanHint: '这些配置对应的 Workspace 已从注册表移除。插件不会自动删除它们，避免目录改名导致配置丢失。确认不再需要时再删除。',
        prune: '删除配置',
        loading: '正在读取配置…',
        loadFailed: '读取配置失败',
        retry: '重试',
        conflict: '配置已被其他窗口修改，本次保存未写入。',
        noWorkspaceSelected: '请选择左侧的工作区。',
        capabilityMissing: '当前部署缺少所需服务：',
        // ── `@子代理` ────────────────────────────────────────────────────────
        // The menu group heading. The trigger source name is an identifier
        // ("workspace-subagents") and the platform renders that as a fallback
        // heading, so the reader-facing string travels on each candidate
        // `section` field instead — the platform mechanism for naming a group in
        // the reader language.
        mentionGroup: '工作区子代理',
        mentionNeedsTask: '继续写任务内容，回车即执行：',
        mentionNoWorkspace: '这个会话不在任何已注册的工作区里，因此没有可用的工作区子代理。',
        mentionUnknown: '没有已启用的子代理叫「{name}」。可用的 key：{keys}',
        mentionAmbiguous: '有多个已启用的子代理显示名都是「{name}」，插件不猜是哪一个是哪一个，因此没有执行。请改用 key 指定：{keys}',
      },
      en: {
        nav: 'Workspaces',
        title: 'Workspaces',
        workspaces: 'Workspaces',
        chooseWorkspace: 'Choose a workspace',
        workspaceLabel: 'Workspace ·',
        tabWorkspace: 'Workspace',
        tabSkills: 'Skills',
        tabSubagents: 'Subagents',
        shownOfTotal: 'Showing',
        totalOf: 'of',
        noWorkspaces: 'No workspaces yet. Create one in the sidebar, then come back to configure it.',
        configured: 'Configured',
        unconfigured: 'Not configured',
        configuredNoProfile: 'This workspace has saved configuration (skill toggles, for example) but no Profile or default perspective has been chosen yet.',
        skipped: 'Skipped',
        blockType: 'Workspace type (saved on submit)',
        profile: 'Profile',
        perspective: 'Default perspective',
        blockNorms: 'Config files and effective state',
        blockNormsHint: 'Everything above is SAVED and active in sessions. "Found" means only that the file exists — this plugin never parses or overwrites it, and AGENTS plus permission rules always outrank this page.',
        pendingEdits: 'The fields above have unsaved edits and are NOT in effect yet — they apply to sessions only after you save.',
        injectionOn: 'Injected',
        injectionOff: 'Not injected',
        injectionOffNoProfile: 'No Profile has been chosen for this workspace, so neither the Profile nor a stance is written into the system prompt. Saving skill toggles alone injects nothing.',
        injectionOffSkipped: 'This workspace is marked "skipped", so no workspace content is written.',
        injectionNone: 'This workspace writes nothing into the system prompt.',
        injectionNeedsRestart: 'The Host has not been restarted: the preview method is new in 0.1.2, the client bundle hot-reloaded but the Host process is still the old one. Restart DSH and reopen this page.',
        viewInjection: 'View the injected prompt',
        view: 'View',
        injectionTitle: 'Injected prompt',
        injectionStoredTitle: '1. Currently saved (in use by sessions)',
        injectionDraftTitle: '2. After saving',
        injectionDirty: 'The form above has unsaved edits. What follows is the SAVED content — it becomes your new choice only after you save.',
        injectionDraftInvalid: 'The draft is not valid, so it cannot be previewed: ',
        injectionNotLoaded: 'The Profile bodies have not finished loading, so this view may be incomplete. Retry in a moment.',
        matterTitle: 'Matter',
        matterHint: 'Read from matter.yaml in this workspace directory; this page is read-only. The plugin never rewrites the matter because you changed a Profile, and never changes your configuration because the file did.',
        matterNone: 'No matter.yaml in this directory — that is what an ordinary project directory looks like, not an error.',
        matterNoneMulti: 'No matter.yaml in any of the directories this workspace declares:',
        matterUnreadable: 'A matter.yaml was found but could not be read: ',
        matterName: 'Name',
        matterRoot: 'Matter directory',
        matterId: 'Matter ID',
        matterType: 'Type',
        matterRole: 'Formal role',
        matterStage: 'Stage',
        matterModules: 'Modules',
        matterMatch: 'Match',
        matterMismatch: 'Mismatch',
        matterOverride: 'Session override',
        matterUnknown: 'Unknown',
        matterProfileMatch: 'Type vs workspace Profile',
        matterPerspectiveMatch: 'Formal role vs default Perspective',
        matterApplyHint: 'Writes the Profile and default Perspective; takes effect once saved.',
        injectionUnavailable: 'Cannot show the injection: ',
        injectionLoadFailed: 'Could not read the injected content',
        injectionOverrideNote: 'This is the WORKSPACE DEFAULT stance. A per-session `/perspective` override does not appear here.',
        injectionEmptySection: '(this section is empty — nothing is written)',
        injectionChars: 'chars',
        injectionCopy: 'Copy all',
        injectionCopied: 'Copied',
        injectionClose: 'Close',
        injectionSectionContext: 'Workspace Profile',
        injectionSectionPerspective: 'Working stance',
        injectionSectionAgents: 'Expert subagent directory',
        globalAgents: 'Global AGENTS',
        projectAgents: 'Project AGENTS.md',
        found: 'Found',
        notFound: 'Not found',
        blockSkills: 'Available skills',
        skillsSearch: 'Search skills',
        skillCountUnit: 'total',
        skillsEmpty: 'No skills to show.',
        skillsUnavailable: 'This deployment mounts no skills service, so no skills can be listed.',
        recommendedTag: 'Recommended',
        disabledTag: 'Disabled',
        missingTag: 'Not installed',
        readonlyTag: 'Read-only',
        missingSkills: 'Recommended but not installed',
        stateRecommended: 'Recommended',
        stateEnabled: 'Available',
        stateDisabled: 'Disabled',
        recommendedByProfile: 'From type',
        recommendedByWorkspace: 'From workspace',
        recommendedByProfileHint: 'Recommended by the workspace type: every workspace of this type recommends this Skill.',
        recommendedByWorkspaceHint: 'Recommended by this workspace only.',
        skillStateLabel: 'Skill state',
        perspectiveHint: 'Switch the working stance for one session with /perspective. It affects only that session and never edits the default here.',
        perspectiveNone: 'This workspace type defines no working stances.',
        blockSubagents: 'Subagent settings',
        noSubagents: 'No subagents configured yet.',
        addSubagent: 'Add subagent',
        edit: 'Edit',
        disable: 'Disable',
        enable: 'Enable',
        duplicate: 'Duplicate',
        remove: 'Delete',
        save: 'Save',
        saving: 'Saving…',
        discard: 'Discard',
        unsaved: 'Unsaved changes',
        reload: 'Reload',
        copyDraft: 'Copy my edits',
        copied: 'Copied to clipboard',
        addTitle: 'New subagent',
        editTitle: 'Edit subagent',
        fName: 'Name',
        fKey: 'Key',
        fTemplate: 'Template',
        templateNone: 'No template —',
        // Template labels, names and descriptions stay Chinese in every locale:
        // they are content the owner wrote, not UI copy this dictionary owns.
        templateHint: 'Fills the fields below; everything stays editable before saving. A template is a suggestion, never a saved definition.',
        // The failed-match notice is gone on purpose; see the Chinese bundle.
        templateModelResolved: 'Filled in from the live model catalog:',
        fBackend: 'Execution',
        backendSpawn: 'DSH subagent',
        backendCodex: 'Codex',
        backendHint: 'A DSH subagent runs on this deployment\'s model route (provider / model / reasoning effort). Codex uses the official Codex backend and follows Codex\'s own model configuration, which this plugin does not manage.',
        backendNoteTitle: 'Execution backend',
        backendNoteCodex: 'Model: follows the Codex configuration',
        backendNoteSpawn: 'Model: this deployment\'s model route (below)',
        codexAvailable: 'Codex backend is available',
        codexMissing: 'Codex backend is not installed',
        codexMissingHint: 'This deployment registers no Codex subagent backend. The plugin never installs one, never switches to the DSH subagent backend and never changes the model; a run will instead fail with the reason.',
        codexProblem: 'Could not determine the Codex backend: ',
        fRoute: 'Route',
        fProvider: 'Provider',
        fModel: 'Model',
        fEffort: 'Reasoning effort',
        fDescription: 'Responsibility',
        fInstructions: 'Extra guidance',
        fEnabled: 'Enabled',
        effortDefault: '(model default)',
        keyHint: 'Cannot be changed after creation. Lowercase letters, digits and hyphens only.',
        keyLocked: 'Cannot be changed after creation. To rename, duplicate under the new key and delete the original.',
        descHint: 'One line. It goes into the model-visible expert directory, so state what it does.',
        instructionsHint: 'Optional extra requirements. Do not store case facts here.',
        cancel: 'Cancel',
        create: 'Create',
        routeChecking: 'Checking the model route…',
        routeOk: 'Model route is available',
        routeBad: 'Model route is unavailable',
        deleteConfirm: 'Delete this subagent definition? This cannot be undone.',
        orphanTitle: 'Orphaned configuration (workspace no longer exists)',
        orphanHint: 'The workspace these records belong to has left the registry. The plugin never deletes them automatically — a renamed directory must not cost you your configuration. Remove one only when you are sure.',
        prune: 'Delete record',
        loading: 'Loading configuration…',
        loadFailed: 'Could not load the configuration',
        retry: 'Retry',
        conflict: 'The configuration changed in another window; this save was not written.',
        noWorkspaceSelected: 'Select a workspace on the left.',
        capabilityMissing: 'This deployment is missing: ',
        mentionGroup: 'Workspace subagents',
        mentionNeedsTask: 'Keep typing the task; Enter runs:',
        mentionNoWorkspace: 'This session is not inside a registered workspace, so it has no workspace subagents.',
        mentionUnknown: 'No enabled subagent is called "{name}". Available keys: {keys}',
        mentionAmbiguous: 'Several enabled subagents share the display name "{name}", and this plugin never guesses which is which, so nothing was run. Name one by key instead: {keys}',
      },
    };

    // ── the Remote contribution ─────────────────────────────────────────────
    //
    // Mirrors `src/remote/invocations.js` exactly. It cannot be imported: this
    // file is a classic script with no bundler. `test/client-bundle.test.js`
    // loads this bundle and compares the table against the Host manifest, which
    // is the only reason the duplication is acceptable.

    /** The package name the Gateway keys descriptors by. */
    const PACKAGE = 'dsh-workspace-profile';
    /** The namespace, and therefore what the browser reads as `ctx.remote.workspaceProfile`. */
    const NAMESPACE = 'workspaceProfile';

    /** One business argument in declaration order; the signal rides `cancellation`. */
    const ARGS = [{ name: 'args' }];

    const INVOCATIONS = [
      { method: 'snapshot', implementation: 'remoteSnapshot', parameters: [], cancellable: true },
      { method: 'skills', implementation: 'remoteSkills', parameters: ARGS, cancellable: true },
      { method: 'previewInjection', implementation: 'remotePreviewInjection', parameters: ARGS, cancellable: true },
      { method: 'matter', implementation: 'remoteMatter', parameters: ARGS, cancellable: true },
      { method: 'models', implementation: 'remoteModels', parameters: [], cancellable: true },
      { method: 'validateRoute', implementation: 'remoteValidateRoute', parameters: ARGS, cancellable: true },
      { method: 'subagentsForSession', implementation: 'remoteSubagentsForSession', parameters: ARGS, cancellable: true },
      { method: 'savePolicy', implementation: 'remoteSavePolicy', parameters: ARGS },
      { method: 'putSubagent', implementation: 'remotePutSubagent', parameters: ARGS },
      { method: 'duplicateSubagent', implementation: 'remoteDuplicateSubagent', parameters: ARGS },
      { method: 'removeSubagent', implementation: 'remoteRemoveSubagent', parameters: ARGS },
      { method: 'setSkillState', implementation: 'remoteSetSkillState', parameters: ARGS },
      { method: 'pruneOrphan', implementation: 'remotePruneOrphan', parameters: ARGS },
    ];

    /** The passthrough codec: the Gateway needs a strict codec body, and the Host validates. */
    const passthrough = () => ({ mode: 'strict', parse: (value) => value });

    const TYPERT_REMOTE = {
      package: PACKAGE,
      descriptors: INVOCATIONS.map((invocation) => ({
        id: PACKAGE + '#' + NAMESPACE + '/' + invocation.method,
        service: NAMESPACE,
        namespace: NAMESPACE,
        method: invocation.method,
        implementation: invocation.implementation,
        invocation: { kind: 'direct' },
        parameters: invocation.parameters.map((parameter) => ({
          name: parameter.name,
          wire: parameter.name,
          source: 'json',
          acceptsUndefined: false,
          codec: {
            mode: 'strict',
            typeSymbol: PACKAGE + '#' + NAMESPACE + '/' + invocation.method + ':' + parameter.name,
            create: () => passthrough(),
          },
        })),
        ...(invocation.cancellable ? { cancellation: { parameter: 'signal' } } : {}),
        result: {
          mode: 'strict',
          typeSymbol: PACKAGE + '/' + NAMESPACE + '#' + invocation.method + ':result',
          create: () => passthrough(),
        },
      })),
    };

    // ── small helpers ───────────────────────────────────────────────────────

    /** Unwrap a Remote answer, accepting both the enveloped and bare shapes. */
    function unwrap(result) {
      if (result !== null && typeof result === 'object' && 'ok' in result) {
        if (result.ok === false) {
          const message = result.error && result.error.message ? result.error.message : String(result.error);
          const error = new Error(message);
          error.code = result.error && result.error.code;
          throw error;
        }
        return result.value;
      }
      return result;
    }

    /** Normalize any thrown value into `{code, message}`. */
    function failureOf(error) {
      if (error === null || typeof error !== 'object') return { code: 'unknown', message: String(error) };
      return { code: error.code || 'unknown', message: error.message || String(error) };
    }

    /** Display label for a Profile / Perspective id from the host's vocabulary. */
    function labelOf(list, id) {
      const entry = (list || []).find((item) => item.id === id);
      return entry === undefined ? id : entry.label;
    }

    function Text({ children, style }) {
      return jsx('span', { style, children });
    }

    function Button({ children, onClick, disabled, primary, title, style }) {
      const base = primary ? s.buttonPrimary : s.button;
      return jsx('button', {
        type: 'button',
        title,
        disabled: disabled === true,
        onClick,
        style: disabled === true ? Object.assign({}, base, s.buttonDisabled, style) : Object.assign({}, base, style),
        children,
      });
    }

    function Pill({ children, colour, title }) {
      return jsx('span', { style: s.pill(colour), title, children });
    }

    function Field({ label, children }) {
      return jsxs('div', { style: s.field, children: [
        jsx('div', { style: s.fieldLabel, children: label }),
        jsx('div', { style: s.fieldValue, children }),
      ] });
    }

    /**
     * One titled section, styled as the platform's own settings card.
     *
     * `note` is the small line beside the title — used for the "saved" vs
     * "edited but not saved" distinction, which belongs next to the heading
     * rather than buried at the bottom of the page.
     */
    /**
     * One bordered section, styled as the platform's own settings card.
     *
     * `title` is omitted on the tabs whose own label already names the content —
     * repeating "可用技能" in both the tab and the card head is noise. `grow` makes
     * the card fill its panel and lets its body scroll, which is what the list on
     * the skills tab needs in order to use the height the tab frees up.
     */
    function Card({ title, note, grow, children }) {
      return jsxs('section', { className: grow === true ? C.card + ' ' + C.cardGrow : C.card, children: [
        title === undefined || title === null
          ? null
          : jsxs('div', { className: C.cardHead, children: [
              jsx('h3', { className: C.cardTitle, children: title }),
              note === undefined || note === null ? null : jsx('span', { className: C.badge, children: note }),
            ] }),
        jsx('div', { className: grow === true ? C.cardBody + ' ' + C.cardBodyGrow : C.cardBody, children }),
      ] });
    }

    /** A notice line, coloured by kind. */
    function Notice({ kind, children }) {
      const variant = kind === 'warn' ? C.noticeWarn : kind === 'error' ? C.noticeError : C.noticeOk;
      return jsx('div', { className: C.notice + ' ' + variant, children });
    }

    /**
     * The Workspace picker — the panel's top-left, and its identity.
     *
     * ## Why it is here and not in a block of its own
     *
     * The top of the panel has to name the Workspace anyway, because the tabs
     * below split the page and none of them repeats it: while toggling Skills on
     * one tab you would otherwise have no idea *which* Workspace you are writing
     * to, and a Skill toggle is workspace-scoped, so a mistake is silent. Making
     * that same element the control that changes it removes a whole block and a
     * duplicated label.
     *
     * ## Why not a strip of tabs, and why not a `<select>`
     *
     * Tabs spend *horizontal* space on a list with no upper bound; ten Workspaces
     * either overflow out of sight or truncate to indistinguishable stubs. Tabs
     * are right for the three fixed sections below and wrong for this.
     *
     * A `<select>` would fit, and would lose the one fact that distinguishes two
     * Workspaces: the path. The closed state shows title *and* path, so "which
     * Workspace am I configuring" is answerable without opening anything.
     *
     * ## Semantics
     *
     * A disclosure (`aria-expanded` + `aria-controls`), not a `listbox`: each entry
     * is an ordinary button that selects and closes, so there is no selection
     * model for a listbox to own. Keyboard use is native — Tab reaches the trigger,
     * Enter/Space opens it, Tab then reaches the entries.
     */
    function WorkspacePicker({ t, workspaces, selectedId, onSelect }) {
      const [open, setOpen] = useState(false);
      const listId = 'workspace-profile-picker';
      const active = workspaces.find((workspace) => workspace.workspaceId === selectedId) || null;
      return jsxs(Fragment, { children: [
        jsxs('button', {
          type: 'button',
          className: C.pickHead,
          'aria-expanded': open,
          'aria-controls': listId,
          onClick: () => setOpen(!open),
          children: [
            jsxs('span', { className: C.pickText, children: [
              jsxs('span', { className: C.pickRow, children: [
                jsx('span', { className: C.pickLabel, children: t('workspaceLabel') }),
                jsx('span', {
                  className: C.pickTitle,
                  children: active === null ? t('noWorkspaceSelected') : active.title,
                }),
                jsx('span', {
                  className: C.chevron,
                  'data-open': open ? 'true' : undefined,
                  children: open ? '\u25B4' : '\u25BE',
                }),
              ] }),
              active === null
                ? null
                : jsx('span', { className: C.pickPath, children: active.path }),
            ] }),
          ],
        }),
        open
          ? jsx('div', {
              className: C.pickList,
              id: listId,
              children: workspaces.map((workspace) => jsx('button', {
                key: workspace.workspaceId,
                type: 'button',
                className: C.pickItem,
                'data-active': workspace.workspaceId === selectedId ? 'true' : undefined,
                onClick: () => { onSelect(workspace.workspaceId); setOpen(false); },
                children: [
                  jsx('span', { className: C.pickTitle, children: workspace.title }),
                  jsx('span', { className: C.pickPath, children: workspace.path }),
                ],
              })),
            })
          : null,
      ] });
    }

    /**
     * The three section tabs.
     *
     * Transcribed from the platform's own settings tabs: `tablist` / `tab` /
     * `tabpanel` roles, `aria-selected`, `aria-controls`, a roving `tabIndex` so
     * the strip is a single tab stop, and Arrow/Home/End movement within it. The
     * count here is fixed at three, which is exactly why tabs are safe for the
     * sections and were not safe for the Workspaces.
     */
    function SectionTabs({ tabs, activeId, onSelect }) {
      const refs = useRef([]);
      const move = (event, index) => {
        let next;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        else return;
        event.preventDefault();
        onSelect(tabs[next].id);
        const target = refs.current[next];
        if (target) target.focus();
      };
      return jsx('div', {
        className: C.tabs,
        role: 'tablist',
        children: tabs.map((tab, index) => {
          const active = tab.id === activeId;
          return jsxs('button', {
            ref: (element) => { refs.current[index] = element; },
            id: 'workspace-profile-tab-' + tab.id,
            key: tab.id,
            type: 'button',
            role: 'tab',
            className: C.tab,
            'aria-selected': active,
            // The dot is the only cue that a draft is staged on another tab, and a
            // dot says nothing aloud — so the label carries the words.
            'aria-label': tab.dot ? tab.label + '（有未保存的更改）' : tab.label,
            'aria-controls': 'workspace-profile-panel-' + tab.id,
            'data-active': active ? 'true' : undefined,
            tabIndex: active ? 0 : -1,
            onClick: () => onSelect(tab.id),
            onKeyDown: (event) => move(event, index),
            children: [
              tab.label,
              tab.dot ? jsx('span', { className: C.tabDot, 'aria-hidden': 'true' }) : null,
            ],
          });
        }),
      });
    }

    /** An error boundary: without one, any render throw here is simply a blank seat. */
    class SectionBoundary extends Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error };
      }
      componentDidCatch(error) {
        // eslint-disable-next-line no-console
        console.error('[workspace-profile] section render failed', error);
      }
      render() {
        if (this.state.error !== null) {
          const detail = this.state.error && this.state.error.stack ? this.state.error.stack : String(this.state.error);
          return jsxs('div', {
            style: Object.assign({}, s.notice(ERROR), { margin: 16, fontFamily: 'ui-monospace, monospace', fontSize: 12 }),
            'data-workspace-profile-error': 'render',
            children: ['Workspace Composition 渲染失败：\n', detail],
          });
        }
        return this.props.children;
      }
    }

    // ── `@子代理` ───────────────────────────────────────────────────────────
    //
    // The `@` trigger source that lets a user address a Workspace Subagent
    // directly. Everything below is *selection*; nothing below runs anything.
    // A pick, a typed `@key ` and the menu all end in the same place — a
    // `CommandClaim` whose `submit` sends `/agent <key> <task>` to the Host — so
    // the model tool, `/agent` and `@` share one execution path and cannot
    // drift on the preflight, the depth cap, cancellation or disposal.
    //
    // ## The two platform facts this design is built on, both read from source
    //
    // - **`matchEnter` is not reached for an `@` draft today.** The composer's
    //   submit machine adjudicates only drafts that start with `/`
    //   (`ui-conversation`, `SubmitMachine.onEnter`: `if (trimmed.startsWith("/"))`
    //   → `adjudicate`), so a leading `@码农 修一下` is submitted as an ordinary
    //   message unless something claims it first. It is `matchSpace` that fires
    //   for `@`: the controller's `onSpace()` polls every source registered for
    //   the hit's trigger char, with no trigger filter. So typing `@码农` and
    //   then a space is what claims the line, and the user then types the task.
    //   `matchEnter` is still implemented — it is the contract's enter hook and
    //   the adjudicator does iterate `@` sources when it is called — but the
    //   served composer is not the thing that calls it for us.
    // - **The group heading cannot come from `name`.** `name` is the source's
    //   identity (duplicate `(trigger, name)` pairs throw) and the platform
    //   renders `t(source.name)` as the fallback heading. The reader-facing
    //   heading therefore travels on each candidate's `section`, which is the
    //   platform's own mechanism for naming a group in the user's language.

    /** The trigger character this source binds to. */
    const MENTION_TRIGGER = '@';
    /**
     * The source's identity. Fixed by the plan, and load-bearing: it is what the
     * platform keys the group by, so it must not change between releases.
     */
    const MENTION_SOURCE_NAME = 'workspace-subagents';
    /** The command a mention ultimately runs. */
    const MENTION_AGENT_COMMAND = 'agent';

    /**
     * One Session's mention cache.
     *
     * Per Session, because the answer is per Workspace and a Session's Workspace
     * is the thing that decides it: a different Session is a different question,
     * and one cache shared across sessions would answer it with another
     * Workspace's experts.
     *
     * @type {Map<string, any>}
     */
    const MENTION_STATES = new Map();

    /** The settings namespace whose writes invalidate the mention cache. */
    const MENTION_SETTINGS_NAMESPACE = 'workspace-profile';

    /**
     * The cache entry for one Session, created on first use.
     *
     * @param {string} sessionId - the Session.
     * @returns {any} its entry.
     */
    function mentionState(sessionId) {
      let state = MENTION_STATES.get(sessionId);
      if (state === undefined) {
        state = {
          sessionId,
          status: 'cold',
          generation: 0,
          items: [],
          workspaceId: null,
          message: null,
          error: null,
          pending: undefined,
          listeners: new Set(),
        };
        MENTION_STATES.set(sessionId, state);
      }
      return state;
    }

    /**
     * Tell this Session's `subscribeLexicon` listeners that the roll moved.
     *
     * @param {any} state - the cache entry.
     * @returns {void}
     */
    function notifyMention(state) {
      for (const listener of [...state.listeners]) {
        try {
          listener();
        } catch (error) {
          // A listener is the render path. One that throws must not cost the
          // others their notification, and must not escape into the fetch.
          // eslint-disable-next-line no-console
          console.error('[workspace-profile] a lexicon listener failed', error);
        }
      }
    }

    /**
     * Drop cached mention catalogs.
     *
     * Called for every event that can change the answer while the page is open:
     * a local write from the Settings section, any write to this settings
     * namespace from anywhere (including another tab), and a connection reset —
     * the platform's own signal that "wire-derived caches must repull".
     *
     * A `generation` bump is what makes a late answer from a superseded read
     * harmless: the in-flight fetch checks it before writing, so a reply that
     * arrives after the configuration changed cannot repopulate the cache with
     * the older answer.
     *
     * @param {string} [sessionId] - one Session, or every Session when omitted.
     * @returns {void}
     */
    function invalidateMentions(sessionId) {
      for (const [key, state] of MENTION_STATES) {
        if (sessionId !== undefined && key !== sessionId) continue;
        state.generation += 1;
        state.status = 'cold';
        state.items = [];
        state.pending = undefined;
        notifyMention(state);
      }
    }

    /**
     * Read (or rejoin) the mention catalog for one Session.
     *
     * Concurrent callers share one request: the menu re-asks on every keystroke,
     * and a `@` typed over a cold cache would otherwise issue one Remote call per
     * character. The caller's own `signal` is deliberately **not** used for the
     * fetch — it is superseded on every query change, and cancelling the shared
     * read whenever the user types would mean the cache never filled. The
     * caller's signal is still honoured where it matters: the answer is dropped
     * if that caller has gone away.
     *
     * @param {any} remote - the mounted `remote.workspaceProfile` namespace.
     * @param {string} sessionId - the Session.
     * @returns {Promise<any>} the settled cache entry.
     */
    function loadMentions(remote, sessionId) {
      const state = mentionState(sessionId);
      if (state.status === 'ready' || state.status === 'failed') return Promise.resolve(state);
      if (state.pending !== undefined) return state.pending;

      const generation = state.generation;
      state.status = 'loading';
      state.pending = (async () => {
        try {
          const value = unwrap(await remote.subagentsForSession({ sessionId }));
          if (state.generation !== generation) return state;
          state.workspaceId = value && typeof value.workspaceId === 'string' ? value.workspaceId : null;
          state.items = value && value.available === false ? [] : ((value && value.subagents) || []);
          state.message = value && typeof value.message === 'string' ? value.message : null;
          state.error = null;
          state.status = 'ready';
        } catch (error) {
          if (state.generation !== generation) return state;
          state.error = failureOf(error);
          state.status = 'failed';
        } finally {
          if (state.generation === generation) {
            state.pending = undefined;
            notifyMention(state);
          }
        }
        return state;
      })();
      // A failed read is reported to each awaiting caller; this keeps the shared
      // promise from becoming an unhandled rejection when nobody is waiting.
      state.pending.catch(() => {});
      return state.pending;
    }

    /**
     * Resolve one typed reference against the cache.
     *
     * Key wins outright. A display name is matched only when it is **unique**
     * among enabled definitions: two experts can legitimately share a display
     * name, and guessing which one the user meant would run their work on a
     * coin toss. An ambiguous name is reported as such, and the caller refuses
     * rather than picking — the plan's 重名 rule.
     *
     * @param {any[]} items - the cached mention rows.
     * @param {string} reference - the text after `@`.
     * @returns {{ ok: true, item: any } | { ok: false, reason: 'unknown'|'ambiguous', keys: string[] }} the verdict.
     */
    function matchMentionReference(items, reference) {
      const wanted = typeof reference === 'string' ? reference.trim() : '';
      if (wanted === '') return { ok: false, reason: 'unknown', keys: [] };
      const byKey = items.find((item) => item.key === wanted);
      if (byKey !== undefined) return { ok: true, item: byKey };
      const byName = items.filter((item) => item.name === wanted);
      if (byName.length === 1) return { ok: true, item: byName[0] };
      if (byName.length > 1) {
        return { ok: false, reason: 'ambiguous', keys: byName.map((item) => item.key).sort() };
      }
      return { ok: false, reason: 'unknown', keys: [] };
    }

    /**
     * The menu rows for a query, in the platform's candidate shape.
     *
     * `name` is the **key** and `label` the display name, which is what makes
     * both `@code-expert` and `@代码专家` find the same agent: the platform
     * searches `name` and `label` (and renders the label with the name as a
     * trailing alias when they differ).
     *
     * @param {any[]} items - the cached mention rows.
     * @param {string} query - the live query between `@` and the caret.
     * @param {string} section - the reader-facing group heading.
     * @returns {any[]} the candidates, best match first.
     */
    function mentionRows(items, query, section) {
      const rows = items.map((item) => ({
        name: item.key,
        label: item.name,
        // Route first, then the responsibility line: the two questions a reader
        // has are "which one is this" and "where does it run", and the row is
        // one line wide.
        description: item.routeLabel + ' · ' + item.description,
        section,
        value: item.key,
      }));
      const wanted = typeof query === 'string' ? query.trim().toLowerCase() : '';
      if (wanted === '') return rows;
      return rows
        .filter((row) => mentionMatches(row.name, wanted) || mentionMatches(String(row.label || ''), wanted))
        .sort((a, b) => mentionRank(a.name, wanted) - mentionRank(b.name, wanted)
          || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    }

    /**
     * Whether a query is a case-insensitive, ordered subsequence of a name.
     *
     * Subsequence rather than substring so `@codexprt` still finds
     * `code-expert` — the same matcher the platform's own `/` menu uses for
     * command names, so the two menus feel the same.
     *
     * @param {string} haystack - the name to search.
     * @param {string} needle - the lower-cased query.
     * @returns {boolean} whether it matches.
     */
    function mentionMatches(haystack, needle) {
      const text = haystack.toLowerCase();
      let index = 0;
      for (const character of needle) {
        index = text.indexOf(character, index);
        if (index === -1) return false;
        index += 1;
      }
      return true;
    }

    /**
     * Sort weight: prefix matches first, then by position of the first hit.
     *
     * @param {string} name - the candidate key.
     * @param {string} needle - the lower-cased query.
     * @returns {number} the weight.
     */
    function mentionRank(name, needle) {
      const text = name.toLowerCase();
      return text.startsWith(needle) ? 0 : text.indexOf(needle[0] ?? '') + 1;
    }

    /**
     * Split a leading `@…` line into its reference and its task.
     *
     * Only the *first* whitespace-delimited run is the reference. The rest is the
     * user's prose and is preserved verbatim — collapsing its internal spacing
     * would be editing a task that is about to be handed to a model.
     *
     * @param {string} line - the trimmed draft.
     * @returns {{ reference: string, task: string }|null} the parts, or `null` when
     *   the line is not a leading `@` token.
     */
    function parseMentionLine(line) {
      const text = typeof line === 'string' ? line.trim() : '';
      if (!text.startsWith(MENTION_TRIGGER)) return null;
      const body = text.slice(MENTION_TRIGGER.length);
      const split = body.search(/\s/);
      if (split === -1) return { reference: body, task: '' };
      return { reference: body.slice(0, split), task: body.slice(split + 1) };
    }

    /**
     * Send one `/agent` line and translate its settlement for the composer.
     *
     * The wire answer is `{ commandId, result }`, where `result` is the Host's own
     * `CommandResult` (`dsh-api-remotes/lib/client.js`, the `commands/execute`
     * descriptor). **The settlement is passed through**, because `/agent` reports
     * every dispatch failure as `kind: 'error'` with the reason the user needs —
     * an absent Codex backend, a reference that matches nothing, a refused
     * dispatch. Reporting those as success is the one thing this translation must
     * never do: the plan's §29 "Backend Missing" asks for a clear error, and a
     * failed dispatch settles as an error so the composer keeps the draft (and the
     * claim) instead of consuming it.
     *
     * This deliberately departs from `dsh-client-ui-commands.execute` in one place:
     * that client returns plain success for a handler error when the draft carries
     * no attachments, relying on the Host's `command/done` log rendering as a chat
     * command card. The card is a second surface, not a substitute: the plan's §29
     * asks `@代码专家` to *return* a clear error, and a success settlement also
     * consumes the draft and the claim, so retrying after installing the backend
     * would mean retyping the whole task.
     *
     * Success carries no text on purpose: `SubmitOutcome.text` is optional, the
     * platform's own command client omits it, and a success settlement renders as
     * an `info` notice — echoing the child Agent's whole report into the composer
     * would duplicate the card.
     *
     * @param {any} commands - the mounted `remote.commands` namespace.
     * @param {string} sessionId - the Session scope of the call.
     * @param {string} line - the complete slash-command line.
     * @param {readonly any[]} attachments - serialized draft attachments.
     * @returns {Promise<{ kind: 'success'|'error', text?: string }>} the outcome.
     */
    async function runAgentLine(commands, sessionId, line, attachments) {
      const result = await commands.execute(sessionId, line, attachments ?? []);
      if (result !== null && typeof result === 'object' && result.ok === false) {
        const failure = result.error || {};
        throw new Error('command.execute failed: ' + (failure.code || 'unknown') + ': ' + (failure.message || ''));
      }
      const value = result !== null && typeof result === 'object' && 'ok' in result ? result.value : result;
      if (value === undefined) return { kind: 'error', text: 'unknown or malformed command: ' + line };
      const settled = value !== null && typeof value === 'object' ? value.result : undefined;
      if (settled === null || typeof settled !== 'object') {
        // A value without a settlement is not a shape this composer can report on.
        // Refusing is the safe answer: "success" would claim a dispatch nobody
        // confirmed, and throwing would lose the line that failed.
        return { kind: 'error', text: 'malformed command result: ' + line };
      }
      if (settled.kind === 'success') return { kind: 'success' };
      // Anything else is a failure to report, including a kind this build does not
      // know — an unrecognised settlement is not evidence that the command ran.
      const text = typeof settled.text === 'string' && settled.text !== ''
        ? settled.text
        : 'command failed: ' + line;
      return { kind: 'error', text };
    }

    /**
     * Build the claim a mention produces.
     *
     * The claim's `token` is the spelling the draft keeps (`@码农 `), while the
     * line that actually runs is the command's own (`/agent coding …`). Keeping
     * the two apart is what lets a user write in Chinese and still reach a
     * stable, typeable key.
     *
     * @param {object} input - the claim inputs.
     * @param {any} input.commands - the mounted `remote.commands` namespace.
     * @param {string} input.sessionId - the Session the call is scoped to.
     * @param {string} input.key - the Subagent's key.
     * @param {string} input.shown - the spelling kept in the draft.
     * @param {string} input.askForTask - copy used when Enter arrives with no task.
     * @returns {any} the `CommandClaim`.
     */
    function mentionClaim({ commands, sessionId, key, shown, askForTask }) {
      return {
        // The underlying command is `/agent` — this is what the composer keys
        // per-command copy by, and what the Host actually executes.
        name: MENTION_AGENT_COMMAND,
        token: MENTION_TRIGGER + shown + ' ',
        hint: askForTask + ' /' + MENTION_AGENT_COMMAND + ' ' + key,
        submit: async (args, _actx, attachments) => {
          const task = typeof args === 'string' ? args.trim() : '';
          if (task === '') return { kind: 'error', text: askForTask };
          return runAgentLine(commands, sessionId, '/' + MENTION_AGENT_COMMAND + ' ' + key + ' ' + args, attachments);
        },
      };
    }

    /**
     * Create the `@` trigger source.
     *
     * @param {object} deps - the source's dependencies.
     * @param {any} deps.remote - the `remote.workspaceProfile` namespace.
     * @param {any} deps.commands - the `remote.commands` namespace.
     * @param {Function} deps.t - the locale lookup.
     * @returns {any} the `InputTriggerSource`.
     */
    function createMentionSource({ remote, commands, t }) {
      return {
        trigger: MENTION_TRIGGER,
        name: MENTION_SOURCE_NAME,
        // The heading rides each candidate's `section`; see the section note.
        showGroupTitle: false,

        async candidates(session, req) {
          // Leading only. A mention in the middle of a sentence is prose — the
          // user is talking *about* an agent, not dispatching one — and the plan
          // makes that the rule rather than a preference, so no candidate is
          // offered and the menu never opens there.
          if (req.position !== 'leading') return [];
          const state = await loadMentions(remote, session.sessionId);
          // The caller's signal is superseded on every query change; an aborted
          // ask must not render rows for a query that no longer exists.
          if (req.signal !== undefined && req.signal.aborted) return [];
          if (state.status !== 'ready') return [];
          return mentionRows(state.items, req.query, t('mentionGroup'));
        },

        onPick(pick) {
          if (pick.position !== 'leading') return undefined;
          const key = typeof pick.candidate.value === 'string' && pick.candidate.value !== ''
            ? pick.candidate.value
            : pick.candidate.name;
          const shown = typeof pick.candidate.label === 'string' && pick.candidate.label !== ''
            ? pick.candidate.label
            : key;
          return {
            claim: mentionClaim({
              commands,
              sessionId: pick.session.sessionId,
              key,
              shown,
              askForTask: t('mentionNeedsTask'),
            }),
          };
        },

        matchSpace(session, token) {
          if (typeof token !== 'string' || !token.startsWith(MENTION_TRIGGER)) return undefined;
          // Hot state only, and synchronously: this runs mid-keystroke. A cold
          // cache answers "not mine" rather than starting a fetch nobody can
          // await, and the next space — or the menu — picks it up.
          const state = MENTION_STATES.get(session.sessionId);
          if (state === undefined || state.status !== 'ready') return undefined;
          const found = matchMentionReference(state.items, token.slice(MENTION_TRIGGER.length));
          if (!found.ok) return undefined;
          return {
            claim: mentionClaim({
              commands,
              sessionId: session.sessionId,
              key: found.item.key,
              shown: found.item.name,
              askForTask: t('mentionNeedsTask'),
            }),
          };
        },

        async matchEnter(session, line, signal) {
          const parsed = parseMentionLine(line);
          if (parsed === null) return undefined;
          const state = await loadMentions(remote, session.sessionId);
          if (state.status !== 'ready') return undefined;
          const found = matchMentionReference(state.items, parsed.reference);
          if (found.ok !== true) {
            // An unknown token may well be another source's (`@src/index.js`);
            // an *ambiguous* one is unambiguously ours, and refusing loudly is
            // the whole point — the draft is kept and the notice says what to
            // type instead.
            if (found.reason !== 'ambiguous') return undefined;
            throw new Error(t('mentionAmbiguous', { name: parsed.reference, keys: found.keys.join(', ') }));
          }
          return {
            claim: mentionClaim({
              commands,
              sessionId: session.sessionId,
              key: found.item.key,
              shown: found.item.name,
              askForTask: t('mentionNeedsTask'),
            }),
          };
        },

        warm(session) {
          // Scope birth: fetch once so the first `@` filters locally, and so the
          // lexicons below have a roll to offer. Fire-and-forget by contract.
          void loadMentions(remote, session.sessionId).catch(() => {});
        },

        lexicon(session) {
          const state = MENTION_STATES.get(session.sessionId);
          if (state === undefined || state.status !== 'ready') return undefined;
          // Keys only. The platform's plain-text scan matches `[\w-]+` after the
          // trigger, so a Chinese display name can never be a text reference —
          // offering one would be a list nobody can match. `@code-expert` is.
          return state.items.map((item) => item.key);
        },

        subscribeLexicon(session, listener) {
          const state = mentionState(session.sessionId);
          state.listeners.add(listener);
          return () => {
            state.listeners.delete(listener);
          };
        },
      };
    }

    // ── the section ─────────────────────────────────────────────────────────

    function WorkspaceCompositionSection(props) {
      const { remote, locale, validateRoute } = props;

      const [status, setStatus] = useState('loading');
      const [snapshot, setSnapshot] = useState(null);
      const [loadError, setLoadError] = useState(null);
      const [selectedId, setSelectedId] = useState(null);
      const [draft, setDraft] = useState(null);
      const [notice, setNotice] = useState(null);
      const [busy, setBusy] = useState(false);
      const [skills, setSkills] = useState(null);
      /** Which Workspace the loaded catalog belongs to; null before any load. */
      const loadedFor = useRef(null);
      // Which section tab is showing. `workspace` first: it is where a Workspace
      // is chosen, and every other tab is scoped by that choice.
      const [tab, setTab] = useState('workspace');
      const [models, setModels] = useState(null);
      const [dialog, setDialog] = useState(null);
      const [copied, setCopied] = useState(false);
      /**
       * The injection preview when open: `null` while closed, then
       * `{ state: 'loading' }` → `{ state: 'ready', value }` or
       * `{ state: 'error', error }`. One value rather than three flags, so "not
       * open yet" and "open but empty" cannot be read as the same thing.
       */
      const [injection, setInjection] = useState(null);
      /**
       * The CaseBench Matter this Workspace's directory declares, and how it
       * compares with the stored configuration. Read-only: the page reports, it
       * does not re-point the Workspace.
       */
      const [matter, setMatter] = useState(null);
      const [injectionCopied, setInjectionCopied] = useState(false);
      const [, setLocaleRev] = useState(0);

      const t = useMemo(() => locale.bind(NS), [locale]);

      // The bound translate function reads the active locale when called, so a
      // language switch only needs a re-render — which is what this subscription
      // is for.
      useEffect(() => locale.subscribe(() => setLocaleRev((value) => value + 1)), [locale]);

      // NOTE on call shape: a Remote method is called with its BUSINESS
      // arguments only, positionally, and nothing else. The carrier appends the
      // cancellation signal itself, so a method declaring no business parameter
      // takes no argument at all — `snapshot()`, never `snapshot(undefined)`.
      // A trailing `undefined` is not ignored: the call is built with one
      // argument too many, the endpoint never completes, and the UI waits on a
      // request that will not answer. There is no error to see.
      const load = useCallback(async () => {
        try {
          const next = unwrap(await remote.snapshot());
          setSnapshot(next);
          setLoadError(null);
          setStatus('ready');
        } catch (error) {
          setLoadError(failureOf(error));
          setStatus('error');
        }
      }, [remote]);

      useEffect(() => { void load(); }, [load]);

      // Load the model catalog once; it is not per-workspace.
      useEffect(() => {
        let alive = true;
        void (async () => {
          try {
            const value = unwrap(await remote.models());
            if (alive) setModels(value);
          } catch (error) {
            if (alive) setModels({ available: false, providers: [], message: failureOf(error).message });
          }
        })();
        return () => { alive = false; };
      }, [remote]);

      const workspaces = (snapshot && snapshot.workspaces) || [];
      const orphans = (snapshot && snapshot.orphans) || [];
      const selected = workspaces.find((workspace) => workspace.workspaceId === selectedId) || null;
      /**
       * Whether this deployment can actually run a Codex Subagent.
       *
       * Read from the Host's capability map, never inferred here: the answer is
       * "which providers are registered in `ctx.subagents`", and only the Host
       * can see that. `problem` carries a detection failure separately from
       * absence, because "no Codex backend" and "I could not tell" call for
       * different actions from the user.
       */
      const codex = {
        available: !!(snapshot && snapshot.capabilities && snapshot.capabilities.codexBackend),
        problem: (snapshot && snapshot.capabilities && snapshot.capabilities.codexBackendProblem) || null,
      };

      // Default the selection to the first workspace, and repair it when the
      // selected one disappears.
      useEffect(() => {
        if (workspaces.length === 0) {
          if (selectedId !== null) setSelectedId(null);
          return;
        }
        if (selectedId === null || !workspaces.some((workspace) => workspace.workspaceId === selectedId)) {
          setSelectedId(workspaces[0].workspaceId);
        }
      }, [snapshot, selectedId, workspaces]);

      // Reset the editable draft whenever the selected workspace or the stored
      // revision changes. Keying on the revision is what makes a save land: the
      // snapshot that comes back carries the post-write policy.
      const policy = selected ? selected.policy : null;
      const revision = snapshot ? snapshot.revision : null;

      // Read the Matter whenever the selection changes *or* the revision moves.
      // The facts are a property of the directory, but the comparison is against
      // the stored policy, so a save must recompute the verdict rather than leave
      // a stale "mismatch" on screen. Declared after `revision` because the
      // dependency array evaluates it; earlier would be a temporal dead zone.
      useEffect(() => {
        if (selectedId === null) {
          setMatter(null);
          return undefined;
        }
        let alive = true;
        setMatter({ state: 'loading' });
        void (async () => {
          try {
            const value = unwrap(await remote.matter({ workspaceId: selectedId }));
            if (alive) setMatter({ state: 'ready', value });
          } catch (error) {
            if (alive) setMatter({ state: 'error', error: failureOf(error) });
          }
        })();
        return () => { alive = false; };
      }, [remote, selectedId, revision]);

      /**
       * The Matter card: what the directory declares, and whether this Workspace
       * agrees with it.
       *
       * **It reports; it does not apply.** A mismatch is a fact to show, not a
       * defect to fix silently — re-pointing a Workspace because a file on disk
       * changed would make a professional judgement on the user's behalf, and the
       * file can change without the user touching this page.
       */
      const renderMatterCard = () => {
        if (selected === null) return null;
        const title = t('matterTitle');
        if (matter === null || matter.state === 'loading') {
          return jsx(Card, { title, children: jsx('div', { style: s.hint, children: t('loading') }) });
        }
        if (matter.state === 'error') {
          return jsx(Card, { title, children: jsx('div', { style: s.notice(WARN), children: t('loadFailed') + '：' + matter.error.message }) });
        }
        const value = matter.value;
        if (value.available === false) {
          return jsx(Card, { title, children: jsx('div', { style: s.hint, children: value.message }) });
        }
        if (!value.discovered) {
          // Two different facts share `discovered: false`, and conflating them would
          // put a false statement on the page: "there is no matter.yaml here" is
          // wrong when one exists and could not be read. The problem, when present,
          // is the whole answer.
          if (value.problem) {
            return jsx(Card, { title, children: jsx('div', { style: s.notice(WARN), children: t('matterUnreadable') + value.problem }) });
          }
          // A Workspace may declare several directories, so "这个目录下没有" is a
          // statement about one directory that the user never made. Name the set
          // that was actually searched — the page's job is to say what was looked
          // at, not to imply the answer was obvious.
          //
          // One directory keeps the plain sentence: there is nothing to
          // disambiguate, and a list of one reads as a machine talking.
          const searched = Array.isArray(value.searched) ? value.searched : [];
          if (searched.length <= 1) {
            return jsx(Card, { title, children: jsx('div', { style: s.hint, children: t('matterNone') }) });
          }
          return jsx(Card, { title, children: jsxs('div', { style: s.hint, children: [
            jsx('div', { children: t('matterNoneMulti') }),
            // One element per directory, so each is a line of its own and a long
            // path wraps inside the card instead of running out of it.
            ...searched.map((directory) => jsx('div', { key: directory, style: s.fieldValue, children: directory })),
          ] }) });
        }
        const facts = value.matter;
        const verdict = (which) => {
          const kind = value.match[which].verdict;
          const label = kind === 'match' ? t('matterMatch')
            : kind === 'override' ? t('matterOverride')
            : kind === 'mismatch' ? t('matterMismatch')
            : t('matterUnknown');
          const colour = kind === 'match' ? SUCCESS : kind === 'mismatch' ? WARN : LABEL_TERTIARY;
          return jsx(Pill, { colour, children: label });
        };
        return jsxs(Card, { title, children: [
          value.problem
            ? jsx('div', { style: s.notice(WARN), children: t('matterUnreadable') + value.problem })
            : null,
          jsx(Field, { label: t('matterName'), children: jsx(Text, { style: s.fieldValue, children: facts.name }) }),
          // Which directory it was read from. With one directory that is the
          // Workspace itself and says nothing new; with several it answers "where
          // did this come from", which otherwise lives only in the log.
          jsx(Field, { label: t('matterRoot'), children: jsx(Text, { style: s.fieldValue, children: facts.root }) }),
          jsx(Field, { label: t('matterId'), children: jsx(Text, { style: s.fieldValue, children: facts.id }) }),
          jsx(Field, { label: t('matterType'), children: jsx(Text, { style: s.fieldValue, children: facts.type }) }),
          jsx(Field, { label: t('matterRole'), children: jsx(Text, { style: s.fieldValue, children: facts.role }) }),
          jsx(Field, { label: t('matterStage'), children: jsx(Text, { style: s.fieldValue, children: facts.stage }) }),
          facts.modules.length > 0
            ? jsx(Field, { label: t('matterModules'), children: jsx(Text, { style: s.fieldValue, children: facts.modules.join('、') }) })
            : null,
          jsx(Field, { label: t('matterProfileMatch'), children: verdict('profile') }),
          jsx(Field, { label: t('matterPerspectiveMatch'), children: verdict('perspective') }),
          jsx('div', { style: s.hint, children: t('matterHint') }),
        ] });
      };
      /**
       * The stances the selected (or drafted) workspace type offers.
       *
       * Derived here rather than inline because the vocabulary is per-Profile:
       * switching the type in the form must change the options immediately,
       * before any save, and `draft` is the value that moves.
       */
      const activeProfileId = (draft ? draft.profile : null) || (policy ? policy.profile : null);
      const perspectiveOptions = ((snapshot && snapshot.vocabulary.profiles.find((entry) => entry.id === activeProfileId)) || { perspectives: [] }).perspectives;
      /**
       * The stance the select should display.
       *
       * Guarded against a stored id the current type does not offer — a
       * hand-edited settings file can hold one, and an unmatched `value` makes a
       * select silently render its first option, which would show 不设定 while
       * the document says something else. `none` is always in the vocabulary, so
       * it is the safe display fallback.
       */
      const storedPerspective = draft ? draft.defaultPerspective : policy && policy.defaultPerspective;
      const perspectiveValue = perspectiveOptions.some((entry) => entry.id === storedPerspective)
        ? storedPerspective
        : 'none';
      useEffect(() => {
        if (selected === null || policy === null) {
          setDraft(null);
          return;
        }
        setDraft({
          profile: policy.profile,
          defaultPerspective: policy.defaultPerspective,
        });
        setNotice(null);
      }, [selectedId, revision, selected === null]);

      // Load the skill catalog for the selected workspace.
      // Keyed on the Workspace, not on `revision`.
      //
      // It used to depend on `revision`, which every write bumps — so toggling one
      // Skill re-downloaded the whole catalog, and because the first statement was
      // `setSkills(null)` it also emptied the list and flashed a loading state
      // while that happened. At nine Skills that read as a refresh; at several
      // hundred it is a stall and a large pointless round trip. The rows on screen
      // are still the right rows after a toggle, so they stay, and the toggled row
      // is patched in place (see `setSkillState`).
      useEffect(() => {
        if (selected === null) { setSkills(null); loadedFor.current = null; return; }
        // Blanking is right when the Workspace changed — the old rows belong to
        // another Workspace and would be actively misleading. It is not right on a
        // refresh.
        if (loadedFor.current !== selectedId) setSkills(null);
        loadedFor.current = selectedId;
        let alive = true;
        void (async () => {
          try {
            const value = unwrap(await remote.skills({ workspaceId: selected.workspaceId }));
            if (alive) setSkills(value);
          } catch (error) {
            if (alive) setSkills({ available: false, rows: [], missing: [], complete: false, message: failureOf(error).message });
          }
        })();
        return () => { alive = false; };
      }, [remote, selectedId, selected === null]);

      const dirty = selected !== null && draft !== null && policy !== null
        && (draft.profile !== policy.profile || draft.defaultPerspective !== policy.defaultPerspective);

      /** Apply a write result: success reloads, refusal is reported in place. */
      const applyResult = useCallback((result) => {
        if (result && result.saved === true && result.snapshot) {
          setSnapshot(result.snapshot);
          setNotice({ kind: 'success', text: t('save') + ' ✓' });
          // A write here is a change to the `@` menu's answer, and this page is
          // the one place it is edited. The `settings/document-updated` event
          // covers it too, but dropping the cache directly makes the menu correct
          // on the very next `@` rather than whenever the forwarded event lands.
          invalidateMentions();
          return true;
        }
        const code = result ? result.code : 'unknown';
        setNotice({
          kind: code === 'revision-conflict' ? 'conflict' : 'error',
          text: (result && result.message) || t('loadFailed'),
          code,
          snapshot: result ? result.snapshot : undefined,
        });
        return false;
      }, [t]);

      const runWrite = useCallback(async (invoke) => {
        setBusy(true);
        setNotice(null);
        try {
          const result = unwrap(await invoke());
          return applyResult(result);
        } catch (error) {
          setNotice({ kind: 'error', text: failureOf(error).message });
          return false;
        } finally {
          setBusy(false);
        }
      }, [applyResult]);

      const save = useCallback(() => {
        if (selected === null || draft === null) return;
        void runWrite(() => remote.savePolicy({
          workspaceId: selected.workspaceId,
          expectedRevision: revision,
          patch: {
            profile: draft.profile,
            defaultPerspective: draft.defaultPerspective,
            // Saving a Profile is the act that marks a Workspace configured, and
            // that flag — not the presence of any stored value — is what opens the
            // prompt-injection gate. It is written here rather than carried on the
            // draft: the draft is "what the user picked", this is "the
            // consequence of saving it".
            onboardingStatus: 'configured',
          },
        }));
      }, [runWrite, remote, selected, draft, revision]);

      /**
       * Set one Skill's state, and patch that row rather than reloading the list.
       *
       * The write still goes through the revision-fenced Remote call, so a
       * concurrent edit elsewhere is refused exactly as before. What changed is
       * only what happens on success: the row is updated in place. A refused write
       * leaves the list untouched and reports itself, so the two paths stay
       * distinguishable.
       */
      const setSkillState = useCallback((skill, state) => {
        if (selected === null) return;
        void runWrite(() => remote.setSkillState({
          workspaceId: selected.workspaceId, expectedRevision: revision, skill, state,
        })).then((ok) => {
          if (ok !== true) return;
          setSkills((current) => {
            if (current === null || !Array.isArray(current.rows)) return current;
            return Object.assign({}, current, {
              rows: current.rows.map((row) => (row.name === skill
                ? Object.assign({}, row, {
                    // `enabled` is stored as the absence of an override, so the
                    // patch mirrors the Host's own normalisation: anything that is
                    // not `disabled` reads as available.
                    state: state === 'disabled' ? 'disabled' : state === 'recommended' ? 'recommended' : 'enabled',
                    overridden: state !== 'enabled',
                  })
                : row)),
            });
          });
        });
      }, [runWrite, remote, selected, revision]);

      const putSubagent = useCallback((subagent) => {
        if (selected === null) return Promise.resolve(false);
        return runWrite(() => remote.putSubagent({
          workspaceId: selected.workspaceId, expectedRevision: revision, subagent,
        }));
      }, [runWrite, remote, selected, revision]);

      const removeSubagent = useCallback((subagentId) => {
        if (selected === null) return;
        void runWrite(() => remote.removeSubagent({
          workspaceId: selected.workspaceId, expectedRevision: revision, subagentId,
        }));
      }, [runWrite, remote, selected, revision]);

      const duplicateSubagent = useCallback((subagentId) => {
        if (selected === null) return;
        void runWrite(() => remote.duplicateSubagent({
          workspaceId: selected.workspaceId, expectedRevision: revision, subagentId,
        }));
      }, [runWrite, remote, selected, revision]);

      const pruneOrphan = useCallback((workspaceId) => {
        void runWrite(() => remote.pruneOrphan({ workspaceId, expectedRevision: revision }));
      }, [runWrite, remote, revision]);

      const copyDraft = useCallback(() => {
        const text = JSON.stringify({ workspaceId: selectedId, draft }, null, 2);
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard) {
            void navigator.clipboard.writeText(text);
          }
        } catch (error) {
          // Clipboard access can be denied; the draft is still on screen.
        }
        setCopied(true);
      }, [selectedId, draft]);

      /**
       * Fetch the literal prompt text for the selected Workspace.
       *
       * The draft pair rides along, so the dialog can answer "what would this
       * become after saving" without a second round trip. Nothing here writes:
       * the whole operation is a read.
       *
       * Only `draft` is optional, and an omitted argument is omitted — a Remote
       * call is built positionally, so passing `undefined` for a business
       * parameter that was not requested is not the same as not passing it. See
       * the note above `load`.
       */
      const openInjection = useCallback(() => {
        if (selected === null) return;
        setInjectionCopied(false);
        setInjection({ state: 'loading' });
        void (async () => {
          try {
            const args = dirty && draft !== null
              // The draft pair rides along only when saving would actually change
              // something: an "after saving" group identical to the saved one is
              // noise, and it invites the reader to hunt for a difference that is
              // not there.
              ? { workspaceId: selected.workspaceId, profile: draft.profile, perspective: draft.defaultPerspective }
              : { workspaceId: selected.workspaceId };
            const value = unwrap(await remote.previewInjection(args));
            setInjection({ state: 'ready', value });
          } catch (error) {
            setInjection({ state: 'error', error: failureOf(error) });
          }
        })();
      }, [remote, selected, draft]);

      /**
       * Copy the composed text, in the order the model receives it.
       *
       * Empty sections are dropped here rather than in the dialog: the dialog
       * shows them so their absence is legible, but pasting "(this section is
       * empty)" into a prompt is noise. The draft group is included only when it
       * is a legal one, because an invalid draft was never composed.
       */
      const copyInjection = useCallback(() => {
        if (injection === null || injection.state !== 'ready' || !injection.value) return;
        if (injection.value.available === false) return;
        const groups = [injection.value.saved, injection.value.draft]
          .filter((group) => group && group.valid !== false);
        const text = groups
          .flatMap((group) => group.sections || [])
          .map((section) => section.text)
          .filter((part) => part !== '')
          .join('\n\n');
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard) {
            void navigator.clipboard.writeText(text);
          }
        } catch (error) {
          // Clipboard access can be denied; the text is still on screen.
        }
        setInjectionCopied(true);
      }, [injection]);

      if (status === 'loading') {
        return jsx('div', { style: Object.assign({}, s.empty, { padding: 16 }), children: t('loading') });
      }
      if (status === 'error') {
        return jsxs('div', { style: { padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }, children: [
          jsx('div', { style: s.notice(ERROR), children: t('loadFailed') + '：' + (loadError ? loadError.message : '') }),
          jsx(Button, { onClick: () => { setStatus('loading'); void load(); }, children: t('retry') }),
        ] });
      }

      const capabilityGaps = snapshot && snapshot.capabilities
        ? Object.entries(snapshot.capabilities).filter(([, present]) => present === false).map(([name]) => name)
        : [];

      const subagents = policy ? policy.subagents || [] : [];

      // Notices are global, so they sit above the tabs: a save failure or a
      // capability gap is not about one tab, and it must not vanish because the
      // user happened to switch tabs while it was on screen.
      const notices = [
        capabilityGaps.length > 0
          ? jsx(Notice, { key: 'caps', kind: 'warn', children: t('capabilityMissing') + capabilityGaps.join(', ') })
          : null,
        snapshot !== null && snapshot.readError
          ? jsx(Notice, { key: 'read-error', kind: 'error', children: snapshot.readError.message })
          : null,
        notice !== null
          ? jsxs(Notice, {
              key: 'notice',
              kind: notice.kind === 'success' ? 'ok' : notice.kind === 'conflict' ? 'warn' : 'error',
              children: [
                notice.text,
                notice.kind === 'conflict'
                  ? jsxs('div', { style: { display: 'flex', gap: 8, marginTop: 8 }, children: [
                      jsx(Button, { onClick: () => { setNotice(null); void load(); }, children: t('reload') }),
                      jsx(Button, { onClick: copyDraft, children: copied ? t('copied') : t('copyDraft') }),
                    ] })
                  : null,
              ],
            })
          : null,
      ];

      const panel = (id) => ({
        className: C.panelBox,
        id: 'workspace-profile-panel-' + id,
        role: 'tabpanel',
        'aria-labelledby': 'workspace-profile-tab-' + id,
      });

      const tabStrip = jsx(SectionTabs, {
        tabs: [
          { id: 'workspace', label: t('tabWorkspace'), dot: dirty },
          { id: 'skills', label: t('tabSkills') },
          { id: 'subagents', label: t('tabSubagents') },
        ],
        activeId: tab,
        onSelect: setTab,
      });

      return jsxs('div', { className: C.section, 'data-workspace-profile': 'section', children: [
        // ── header: the Workspace's identity, and the control that changes it ──
        jsxs('div', { className: C.head, children: [
          workspaces.length === 0
            ? jsx('h2', { className: C.heading, children: t('title') })
            : jsx(WorkspacePicker, {
                t,
                workspaces,
                selectedId,
                onSelect: (workspaceId) => {
                  if (workspaceId === selectedId) return;
                  // A draft is per-workspace and is discarded on switch, so the
                  // guard belongs here rather than only on the visible button.
                  if (dirty && typeof window !== 'undefined' && !window.confirm(t('unsaved'))) return;
                  setSelectedId(workspaceId);
                },
              }),
          selected !== null
            ? jsx(Pill, {
                colour: hasStoredPolicy(selected) ? SUCCESS : WARN,
                title: policy.onboardingStatus === 'configured' ? '' : t('configuredNoProfile'),
                children: hasStoredPolicy(selected) ? t('configured') : t('unconfigured'),
              })
            : null,
        ] }),

        workspaces.length === 0
          ? jsx('div', { className: C.empty, children: t('noWorkspaces') })
          : tabStrip,

        ...notices,

        selected === null
          ? jsx('div', { ...panel('workspace'), children: jsx('div', { className: C.empty, children: t('noWorkspaceSelected') }) })

          : tab === 'workspace'
          ? jsxs('div', { ...panel('workspace'), children: [
              jsxs(Card, { title: t('blockType'), children: [
                jsx(Field, { label: t('profile'), children: jsxs('div', { style: s.previewHead, children: [
                  jsx('select', {
                    style: s.select,
                    value: draft ? draft.profile : policy.profile,
                    onChange: (event) => {
                      const next = event.target.value;
                      const allowed = (snapshot.vocabulary.profiles.find((entry) => entry.id === next) || { perspectives: [] }).perspectives;
                      setDraft({
                        profile: next,
                        defaultPerspective: allowed.some((entry) => entry.id === draft.defaultPerspective) ? draft.defaultPerspective : 'none',
                      });
                    },
                    children: snapshot.vocabulary.profiles.map((entry) => jsx('option', { key: entry.id, value: entry.id, children: entry.label })),
                  }),
                  jsx(Button, {
                    key: 'view',
                    onClick: openInjection,
                    disabled: busy,
                    // The label is the short 查看 on purpose — it sits in a row of
                    // controls, where "查看注入的提示词" would be a sentence in the
                    // middle of a form. The full wording is one hover away, and the
                    // dialog it opens says the rest.
                    title: t('viewInjection'),
                    children: t('view'),
                  }),
                ] }) }),
                jsx(Field, { label: t('perspective'), children: jsxs('div', { style: s.previewHead, children: [
                  perspectiveOptions.length <= 1
                    // A one-option dropdown is a control that cannot be operated and
                    // looks like it should be. When the workspace type defines no
                    // stances there is nothing to choose, so the page says that
                    // instead of rendering a dead select.
                    ? jsx(Text, { style: s.fieldValue, children: t('perspectiveNone') })
                    : jsx('select', {
                      style: s.select,
                      value: perspectiveValue,
                      onChange: (event) => setDraft(Object.assign({}, draft, { defaultPerspective: event.target.value })),
                      children: perspectiveOptions.map((entry) => jsx('option', { key: entry.id, value: entry.id, children: entry.label })),
                    }),
                  // One 查看 per field, because each field is a separate question:
                  // "is the domain I picked in effect" and "is the stance I picked
                  // in effect". Both open the same dialog — the prompt is written as
                  // a whole, and the dialog labels its three sections — but neither
                  // field is left without its own way to ask.
                  jsx(Button, {
                    key: 'view',
                    onClick: openInjection,
                    disabled: busy,
                    title: t('viewInjection'),
                    children: t('view'),
                  }),
                ] }) }),
                jsx('div', { style: s.hint, children: t('perspectiveHint') }),
              ] }),

              renderMatterCard(),

              // This card reports what is *stored*, which is what the runtime
              // injects; the card above edits a draft. Before the note existed the
              // two could show different values with nothing saying why, and a user
              // reasonably read the editable control above as already applied.
              jsxs(Card, { title: t('blockNorms'), children: [
                dirty ? jsx('div', { style: s.notice(WARN), children: t('pendingEdits') }) : null,
                jsx(Field, { label: t('globalAgents'), children: jsx(Pill, {
                  colour: selected.instructions && selected.instructions.global.present ? SUCCESS : LABEL_TERTIARY,
                  children: selected.instructions && selected.instructions.global.present ? t('found') : t('notFound'),
                }) }),
                jsx(Field, { label: t('projectAgents'), children: jsx(Pill, {
                  colour: selected.instructions && selected.instructions.project.present ? SUCCESS : LABEL_TERTIARY,
                  children: selected.instructions && selected.instructions.project.present ? t('found') : t('notFound'),
                }) }),
                jsx(Field, { label: t('profile'), children: jsx(Text, { style: s.fieldValue, children: labelOf(snapshot.vocabulary.profiles, policy.profile) }) }),
                jsx(Field, { label: t('perspective'), children: jsx(Text, { style: s.fieldValue, children: labelOf(snapshot.vocabulary.perspectives, policy.defaultPerspective) }) }),
                jsx('div', { style: s.hint, children: t('blockNormsHint') }),
              ] }),

              orphans.length > 0
                ? jsxs(Card, { title: t('orphanTitle'), children: [
                    jsx('div', { style: s.hint, children: t('orphanHint') }),
                    orphans.map((orphan) => jsxs('div', { key: orphan.workspaceId, style: s.row, children: [
                      jsx('span', { style: s.rowName, children: orphan.workspaceId }),
                      jsx(Button, { disabled: busy, onClick: () => pruneOrphan(orphan.workspaceId), children: t('prune') }),
                    ] })),
                  ] })
                : null,

              // The draft is profile/perspective only — every other write on this
              // page lands immediately — so the save bar belongs to this tab and
              // not to the others, where it would sit greyed out.
              jsxs('div', { className: C.footer, children: [
                dirty ? jsx('span', { className: C.hint, style: { marginRight: 'auto' }, children: t('unsaved') }) : null,
                jsx('button', {
                  type: 'button',
                  className: C.discard,
                  disabled: !dirty || busy,
                  onClick: () => setDraft({ profile: policy.profile, defaultPerspective: policy.defaultPerspective }),
                  children: t('discard'),
                }),
                jsx('button', {
                  type: 'button',
                  className: C.save,
                  disabled: !dirty || busy,
                  onClick: save,
                  children: busy ? t('saving') : t('save'),
                }),
              ] }),
            ] })

          : tab === 'skills'
          ? jsx('div', { ...panel('skills'), children: jsx(SkillsBlock, {
              t,
              skills,
              busy,
              onToggle: setSkillState,
            }) })

          : jsx('div', { ...panel('subagents'), children: jsxs(Card, { children: [
              // Deliberately NOT `grow`. The card used to stretch to the panel's
              // 569px while holding a single row, so the tab read as one large empty
              // box. It now hugs its content; the space below is the panel's own
              // background, which reads as "nothing more here" rather than as an
              // unfinished container.
              subagents.length === 0
                ? jsx('div', { className: C.subDesc, children: t('noSubagents') })
                : subagents.map((definition) => jsx(SubagentCard, {
                    key: definition.id,
                    t,
                    definition,
                    busy,
                    onEdit: () => setDialog({ mode: 'edit', subagent: definition }),
                    onToggle: () => putSubagent(Object.assign({}, definition, { id: definition.id, enabled: !definition.enabled })),
                    onDuplicate: () => duplicateSubagent(definition.id),
                    onRemove: () => {
                      if (typeof window !== 'undefined' && !window.confirm(t('deleteConfirm'))) return;
                      removeSubagent(definition.id);
                    },
                  })),
              jsx('div', { className: C.subActions, children: jsx('button', {
                type: 'button',
                disabled: busy,
                onClick: () => setDialog({ mode: 'create', subagent: null }),
                children: '+ ' + t('addSubagent'),
              }) }),
            ] }) }),

        dialog !== null
          ? jsx(SubagentDialog, {
              t,
              models,
              mode: dialog.mode,
              initial: dialog.subagent,
              validateRoute,
              codex,
              onCancel: () => setDialog(null),
              onSubmit: async (value) => {
                const ok = await putSubagent(value);
                if (ok) setDialog(null);
              },
            })
          : null,

        injection !== null
          ? jsx(InjectionDialog, {
              t,
              result: injection,
              dirty,
              copied: injectionCopied,
              onCopy: copyInjection,
              onClose: () => setInjection(null),
            })
          : null,
      ] });
    }

    // ── skills block ────────────────────────────────────────────────────────

    /**
     * The skills tab: a search field across the full width, over a scrolling grid.
     *
     * ## Why the height changed
     *
     * This list used to live at the bottom of a long page, so it had to be capped
     * (`max-height: 260px`, about five rows) or it would have pushed everything
     * below it out of view. On its own tab it can have the whole panel, which is
     * the entire reason the sections were split into tabs.
     *
     * ## Why the search box is here rather than in the section
     *
     * The query is local state of this tab. When it lived on the section, every
     * keystroke re-rendered all four cards, the subagent list and the footer —
     * with a few hundred Skills that is the difference between a responsive field
     * and a laggy one.
     *
     * ## Why rendering is incremental rather than virtualised
     *
     * A row's height is not fixed: a long Skill name wraps on purpose, because
     * "prc-legal-research-ca…" is not an identity. Fixed-height windowing would
     * mis-measure those rows and scroll to the wrong place. Appending in chunks
     * assumes nothing about height and caps the first paint at one chunk.
     */
    const SKILL_PAGE = 60;

    function SkillsBlock({ t, skills, busy, onToggle }) {
      const [query, setQuery] = useState('');
      const [limit, setLimit] = useState(SKILL_PAGE);
      // Reset the window whenever the visible set changes, or the revealing done
      // for one search would carry into the next.
      useEffect(() => { setLimit(SKILL_PAGE); }, [query, skills]);

      if (skills === null) {
        return jsx(Card, { grow: true, children: jsx('div', { style: s.empty, children: t('loading') }) });
      }

      const rows = skills.rows || [];
      const needle = query.trim().toLowerCase();
      const filtered = needle === ''
        ? rows
        : rows.filter((row) =>
            row.name.toLowerCase().includes(needle) || (row.description || '').toLowerCase().includes(needle));
      const visible = filtered.slice(0, limit);
      const more = filtered.length - visible.length;

      const header = jsxs('div', { className: C.searchRow, children: [
        jsx('input', {
          style: Object.assign({}, s.input, s.search),
          placeholder: t('skillsSearch'),
          value: query,
          'aria-label': t('skillsSearch'),
          onChange: (event) => setQuery(event.target.value),
        }),
        jsx('span', { className: C.badge, children: needle === ''
          ? rows.length + ' ' + t('skillCountUnit')
          : t('shownOfTotal') + ' ' + Math.min(limit, filtered.length) + ' / ' + t('totalOf') + ' ' + filtered.length }),
      ] });

      if (skills.available === false) {
        return jsx(Card, { grow: true, children: [
          header,
          jsx('div', { style: s.notice(WARN), children: skills.message || t('skillsUnavailable') }),
        ] });
      }

      const notes = [
        skills.complete === false
          ? jsx('div', { key: 'incomplete', style: s.notice(WARN), children: 'Skill 目录本次没有完整发现，下面的结果可能不完整。' })
          : null,
        // The Host reports why a list is short; without this the page would present
        // "recommended but not installed" as a fact when it is only "not visible
        // from here".
        skills.note ? jsx('div', { key: 'note', style: s.notice(LABEL_SECONDARY), children: skills.note }) : null,
        skills.missing && skills.missing.length > 0
          ? jsxs('div', { key: 'missing', style: s.hint, children: [t('missingSkills') + '：', skills.missing.join('、')] })
          : null,
      ];

      return jsxs(Card, { grow: true, children: [
        header,
        ...notes,
        filtered.length === 0
          ? jsx('div', { style: s.empty, children: t('skillsEmpty') })
          : jsx('div', {
              className: C.skillList,
              // Appending on the way down. `scrollTop + clientHeight >= scrollHeight -
              // 120` is the conventional threshold; it fires before the user hits
              // the bottom, so the next chunk is there by the time they get to it.
              onScroll: (event) => {
                const el = event.target;
                if (more <= 0) return;
                if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
                  setLimit((current) => current + SKILL_PAGE);
                }
              },
              children: visible.map((row) => jsx(SkillRow, {
                key: row.name,
                t,
                row,
                busy,
                onToggle,
                recommendationSource: skills.recommendationSources,
              })),
            }),
      ] });
    }

    /**
     * One Skill row: availability switch, name, provenance.
     *
     * ## Why a circle and not a `<select>`
     *
     * A three-state dropdown put the heaviest form control there is on every row —
     * one `<select>` plus three `<option>`s, against nine elements for the whole
     * rest of the row — and in a two-column grid of a few hundred Skills that is
     * the cost that shows. The state it actually needs to express is binary: a
     * Skill is on or off. (The third stored state, `recommended`, is described
     * below.)
     *
     * ## The three things the switch must distinguish
     *
     * On, off, and *not-touchable* — a Skill whose source is not one Settings may
     * write (`bundled`). Off is a solid ring; not-touchable is the same shape at
     * 40% opacity, plus the 只读 pill. Without that difference "I turned this off"
     * and "this is not mine to turn off" look the same, and the second one reads as
     * a broken control.
     *
     * ## `recommended` is no longer settable here
     *
     * It was a third state on the dropdown. The store still accepts and honours it
     * (a Skill recommended by the Workspace's Profile is shown with a badge), but
     * the per-row control that set it is gone — one binary switch per row is what
     * makes a dense grid work. Stored values keep working; nothing is migrated
     * away and nothing silently changes meaning.
     */
    function SkillRow({ t, row, busy, onToggle, recommendationSource }) {
      const enabled = row.state !== 'disabled';
      const managed = row.managed === true;
      const source = recommendationSource ? recommendationSource[row.name] : undefined;
      const sourceLabel = source === 'profile'
        ? t('recommendedByProfile')
        : source === 'workspace' ? t('recommendedByWorkspace') : '';
      const sourceHint = source === 'profile'
        ? t('recommendedByProfileHint')
        : source === 'workspace' ? t('recommendedByWorkspaceHint') : '';
      // Everything the row cannot show at this width lives in the tooltip: the full
      // name (which truncates), the description, and the source. Truncation is only
      // acceptable because the whole value is one hover away.
      const tooltip = [
        row.name,
        row.description || '',
        row.source,
        enabled ? t('stateEnabled') : t('stateDisabled'),
      ].filter((part) => part !== '').join('\n');

      return jsxs('div', {
        className: C.gridCell,
        style: { opacity: enabled ? 1 : 0.65 },
        title: tooltip,
        children: [
          jsx('button', {
            type: 'button',
            role: 'switch',
            className: C.switchBtn,
            'aria-checked': enabled,
            // The circle carries no text, so the accessible name has to come from
            // here — otherwise the control is announced as an unnamed switch.
            'aria-label': row.name + ' — ' + (enabled ? t('stateEnabled') : t('stateDisabled')),
            disabled: busy || !managed,
            title: managed ? t('skillStateLabel') : t('readonlyTag'),
            onClick: () => onToggle(row.name, enabled ? 'disabled' : 'enabled'),
          }),
          // The name is the only flexible item, so it absorbs all the slack and
          // truncates; nothing else moves.
          jsx('span', {
            style: Object.assign({}, s.rowName, {
              textDecoration: enabled ? 'none' : 'line-through',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }),
            children: row.name,
          }),
          // Only the words the dot cannot say. "已启用" was redundant with a green
          // dot and cost the name roughly ten characters — which is the margin
          // between telling `prc-legal-research-case-search` and
          // `prc-legal-research-company-search` apart at this width.
          managed ? null : jsx(Pill, { colour: LABEL_TERTIARY, children: t('readonlyTag') }),
          row.state === 'recommended' && sourceLabel !== ''
            ? jsx(Pill, { colour: BRAND, title: sourceHint, children: t('recommendedTag') })
            : null,
          row.userInvocable === false ? jsx(Pill, { colour: LABEL_TERTIARY, children: 'user: no' }) : null,
        ],
      });
    }

    /**
     * Whether the user has stored anything at all about this Workspace.
     *
     * Deliberately NOT `onboardingStatus === 'configured'`: that field answers
     * "was a Profile and Perspective chosen", which is what gates prompt
     * injection. Disabling one Skill is also a configuration — it is stored and
     * it is enforced — so a badge reading 未配置 next to a page full of the
     * user's saved choices is simply false. Block 二 is where "what is in
     * effect" is reported, so the badge is free to answer the other question.
     *
     * @param {any} workspace - one Workspace row from the snapshot.
     * @returns {boolean} whether any policy is stored for it.
     */
    function hasStoredPolicy(workspace) {
      if (workspace === null || workspace === undefined) return false;
      const policy = workspace.policy || {};
      return (
        policy.onboardingStatus === 'configured'
        || Object.keys(policy.skillOverrides || {}).length > 0
        || (policy.subagents || []).length > 0
      );
    }

    // ── subagent row ────────────────────────────────────────────────────────

    /**
     * One Workspace Subagent, as a card.
     *
     * ## What changed and why
     *
     * This was a bare flex line — name, route, and four equal-weight buttons — with
     * the key invisible and the description reachable only through a tooltip. Three
     * things were wrong with that:
     *
     * - **The key was hidden.** `key` is what the model passes to
     *   `workspace_subagent`; it is the identity this whole feature turns on, and it
     *   appeared nowhere on the page. It is now a monospace chip.
     * - **The description was hidden.** It is the Subagent's "职责" line, injected
     *   into the child as its persona. It is now visible and truncates.
     * - **Four buttons flattened the hierarchy.** 禁用 sat at the same weight as
     *   删除, and it was a *state* among *actions*. The state is now the same switch
     *   the Skills tab uses — one control, one meaning, shared across both tabs.
     *
     * The write path is unchanged: the switch calls the same `onToggle` the 禁用
     * button did, which `putSubagent`s the definition with `enabled` inverted.
     */
    function SubagentCard({ t, definition, busy, onEdit, onToggle, onDuplicate, onRemove }) {
      const enabled = definition.enabled !== false;
      // The Host projects `routeLabel` for every definition, from the one
      // function the model-visible directory also uses. The local fallback keeps
      // the card rendering on an older Host that has not been restarted yet —
      // which is this workspace's normal state while the client hot-reloads
      // ahead of it — instead of printing `undefined/undefined`.
      const route = typeof definition.routeLabel === 'string'
        ? definition.routeLabel
        : (definition.backend === 'codex'
          ? 'Codex'
          : definition.provider + '/' + definition.model
            + (definition.reasoningEffort ? ' · ' + definition.reasoningEffort : ''));
      return jsxs('div', {
        className: C.subCard,
        style: { opacity: enabled ? 1 : 0.65 },
        children: [
          jsxs('div', { className: C.subTop, children: [
            jsx('button', {
              type: 'button',
              role: 'switch',
              className: C.switchBtn,
              'aria-checked': enabled,
              // The circle carries no text, so the name has to come from here.
              'aria-label': definition.name + ' — ' + (enabled ? t('stateEnabled') : t('stateDisabled')),
              disabled: busy,
              title: t('fEnabled'),
              onClick: () => onToggle(),
            }),
            jsx('span', {
              className: C.subName,
              style: { textDecoration: enabled ? 'none' : 'line-through' },
              children: definition.name,
            }),
            // The key is what the model addresses this Subagent by, so it is on
            // screen rather than in a tooltip.
            jsx('span', { className: C.subKey, title: t('fKey'), children: definition.key }),
            jsx('span', { className: C.subRoute, title: route, children: route }),
          ] }),
          jsxs('div', { className: C.subBottom, children: [
            jsx('span', {
              className: C.subDesc,
              title: definition.description || '',
              children: definition.description || '—',
            }),
            jsxs('div', { className: C.subActions, children: [
              jsx('button', { type: 'button', disabled: busy, onClick: onEdit, children: t('edit') }),
              jsx('button', { type: 'button', disabled: busy, onClick: onDuplicate, children: t('duplicate') }),
              jsx('button', { type: 'button', disabled: busy, onClick: onRemove, children: t('remove') }),
            ] }),
          ] }),
        ],
      });
    }

    // ── subagent dialog ─────────────────────────────────────────────────────

    function SubagentDialog({ t, models, mode, initial, validateRoute, onCancel, onSubmit, codex }) {
      const [form, setForm] = useState(() => ({
        id: initial ? initial.id : undefined,
        key: initial ? initial.key : '',
        name: initial ? initial.name : '',
        description: initial ? initial.description : '',
        // `undefined` is what every pre-0.6.0 definition carries, and it means
        // `spawn` — the same answer the Host's `subagentBackend` gives. Filling
        // it in here is what makes editing an old definition write an explicit
        // value without changing where it runs.
        backend: initial && initial.backend === 'codex' ? 'codex' : 'spawn',
        provider: initial ? initial.provider || '' : '',
        model: initial ? initial.model || '' : '',
        reasoningEffort: initial ? initial.reasoningEffort || '' : '',
        instructions: initial ? initial.instructions || '' : '',
        enabled: initial ? initial.enabled : true,
      }));
      const [route, setRoute] = useState(null);
      const [busy, setBusy] = useState(false);
      /**
       * Which template is selected. Held only so the control can show what was
       * picked: choosing a template writes the fields and nothing more, so the
       * form stays the single source of truth for what will be saved.
       */
      const [templateId, setTemplateId] = useState('');
      /**
       * The route a template's `modelSpec` was resolved to, when it was.
       *
       * `null` unless applying a template resolved its spec against the live
       * catalog and wrote the answer into the form; then `{ detail }` holds the
       * `provider/model` that was filled in, rendered under the form.
       *
       * **A failed match says nothing.** The route fields stay empty and the user
       * picks from the Provider / Model lists, which is the whole remedy — the
       * notice that used to name the four failure reasons was removed at the
       * owner's request (CHANGELOG 0.6.0). The plan's 不猜 / 不 fallback rule is
       * unchanged: nothing is guessed, nothing is substituted; it is now enforced
       * by the empty fields and the save button's own required-route check.
       */
      const [templateNote, setTemplateNote] = useState(null);

      const providers = (models && models.providers) || [];
      const provider = providers.find((entry) => entry.provider === form.provider) || null;
      const modelEntry = provider ? (provider.models || []).find((entry) => entry.id === form.model) || null : null;
      const efforts = modelEntry ? modelEntry.efforts || [] : [];
      const isCodex = form.backend === 'codex';

      const update = useCallback((patch) => setForm((current) => Object.assign({}, current, patch)), []);

      /**
       * Apply a factory template to the form.
       *
       * The patch itself comes from {@link templateFormPatch}, which the tests
       * assert directly: this dialog only exists while it is open, so a rule
       * living only here would be unobservable to anything but a real browser.
       */
      const applyTemplate = useCallback((id) => {
        setTemplateId(id);
        setTemplateNote(null);
        const template = SUBAGENT_TEMPLATES.find((entry) => entry.id === id);
        // Choosing the placeholder clears the selection without touching what
        // was typed: there is nothing to restore it from.
        if (template === undefined) return;
        update(templateFormPatch(template, models));
        if (typeof template.modelSpec !== 'string') return;
        const resolved = resolveTemplateRoute(models ?? null, template.modelSpec, template.reasoningEffort);
        // Only the answer that was written in is announced. Every failure reason
        // (`no-catalog`, `not-found`, `ambiguous`, `no-effort`) leaves the route
        // empty **and silent**: the notice that explained the mismatch was removed
        // at the owner's request. Nothing falls back to another model, and the save
        // button still refuses an empty route for a spawn definition.
        if (!resolved.ok) return;
        setTemplateNote({ detail: resolved.provider + '/' + resolved.model });
      }, [update, models]);

      // Live route verdict. Cheap, and the difference between finding out here and
      // finding out when a delegation has already been paid for.
      //
      // Not asked at all for a Codex definition: it has no DSH LLM route, so the
      // honest answer is "not applicable", which the form says in words instead
      // of running a check that could only ever report a false failure.
      useEffect(() => {
        if (isCodex) { setRoute(null); return undefined; }
        if (form.provider === '' || form.model === '') { setRoute(null); return undefined; }
        let alive = true;
        setRoute({ state: 'checking' });
        void (async () => {
          try {
            const value = unwrap(await validateRoute(form.provider, form.model, form.reasoningEffort));
            if (alive) setRoute(Object.assign({ state: value && value.available ? 'ok' : 'bad' }, value || {}));
          } catch (error) {
            if (alive) setRoute({ state: 'bad', reason: failureOf(error).message });
          }
        })();
        return () => { alive = false; };
      }, [isCodex, form.provider, form.model, form.reasoningEffort, validateRoute]);

      const submit = useCallback(async () => {
        setBusy(true);
        try {
          await onSubmit({
            ...(form.id === undefined ? {} : { id: form.id }),
            ...(form.key === '' ? {} : { key: form.key }),
            name: form.name,
            description: form.description,
            backend: form.backend,
            // A Codex definition writes **no** route at all rather than an empty
            // string: the fields are absent from its data model, and an empty
            // `provider` would look like a route the user failed to finish.
            ...(isCodex
              ? {}
              : {
                  provider: form.provider,
                  model: form.model,
                  reasoningEffort: form.reasoningEffort === '' ? undefined : form.reasoningEffort,
                }),
            instructions: form.instructions,
            enabled: form.enabled,
          });
        } finally {
          setBusy(false);
        }
      }, [form, isCodex, onSubmit]);

      const created = mode === 'create';
      const codexReady = codex && codex.available === true;

      return jsx('div', {
        className: C.modalBackdrop,
        onClick: (event) => { if (event.target === event.currentTarget) onCancel(); },
        children: jsxs('div', { className: C.modalPanel, 'data-workspace-profile': 'dialog', children: [
          jsx('h3', { className: C.modalTitle, children: created ? t('addTitle') : t('editTitle') }),

          // Factory templates, offered here rather than in the list: a template
          // is a way to *start* a definition, and this dialog is where one
          // starts. Field order is untouched — the template writes the fields
          // below, so it sits above them. A dropdown, not a row of buttons,
          // because labels are Chinese and the field/Key row below is only
          // 205px per column; buttons would wrap into a second line.
          created
            ? jsxs('div', { className: C.fieldStack, children: [
                jsx('label', { className: C.fieldStackLabel, children: t('fTemplate') }),
                jsx('select', {
                  className: C.control,
                  style: s.select,
                  'aria-label': t('fTemplate'),
                  value: templateId,
                  onChange: (event) => applyTemplate(event.target.value),
                  children: [jsx('option', { key: '', value: '', children: t('templateNone') })].concat(
                    SUBAGENT_TEMPLATES.map((template) => jsx('option', {
                      key: template.id,
                      value: template.id,
                      children: template.label,
                    })),
                  ),
                }),
                jsx('div', { className: C.fieldStackHint, children: t('templateHint') }),
              ] })
            : null,

          // Name and key side by side: on one line each they were two full-width
          // rows for two short values, which is most of why this dialog felt cramped
          // in a panel that had room to spare.
          jsxs('div', { className: C.fieldRow, children: [
            jsxs('div', { className: C.fieldStack, children: [
              jsx('label', { className: C.fieldStackLabel, children: t('fName') }),
              jsx('input', {
                className: C.control,
                style: s.input,
                value: form.name,
                onChange: (event) => update({ name: event.target.value }),
              }),
            ] }),
            jsxs('div', { className: C.fieldStack, children: [
              jsx('label', { className: C.fieldStackLabel, children: t('fKey') }),
              jsx('input', {
                className: C.control,
                style: Object.assign({}, s.input, created ? {} : { opacity: 0.6 }),
                value: form.key,
                disabled: !created,
                placeholder: 'case-researcher',
                onChange: (event) => update({ key: event.target.value }),
              }),
              jsx('div', { className: C.fieldStackHint, children: created ? t('keyHint') : t('keyLocked') }),
            ] }),
          ] }),

          // 执行方式. Its own field group, above the route, because it decides
          // whether there *is* a route: choosing Codex hides Provider / Model /
          // Reasoning entirely and shows what will actually run instead. Hiding
          // rather than disabling is deliberate — a greyed-out model picker on a
          // backend that has no model reads as "you forgot to fill this in".
          jsxs('div', { className: C.fieldStack, children: [
            jsx('label', { className: C.fieldStackLabel, children: t('fBackend') }),
            jsx('select', {
              className: C.control,
              style: s.select,
              'aria-label': t('fBackend'),
              value: form.backend,
              // Switching backend clears the route it no longer describes, so a
              // Codex definition can never carry a leftover `provider`, and
              // switching back does not inherit a route from a different role.
              onChange: (event) => update({ backend: event.target.value, provider: '', model: '', reasoningEffort: '' }),
              children: [
                jsx('option', { key: 'spawn', value: 'spawn', children: t('backendSpawn') }),
                jsx('option', { key: 'codex', value: 'codex', children: t('backendCodex') }),
              ],
            }),
            jsx('div', { className: C.fieldStackHint, children: t('backendHint') }),
            isCodex
              ? jsx('div', {
                  className: C.notice + ' ' + (codexReady && codex.problem === null ? C.noticeOk : C.noticeWarn),
                  children: [
                    jsx('div', { children: t('backendNoteTitle') + '：' + t('backendCodex') }),
                    jsx('div', { children: t('backendNoteCodex') }),
                    jsx('div', {
                      children: codexReady && codex.problem === null
                        ? t('codexAvailable')
                        : t('codexMissing') + (codex.problem === null ? '' : '（' + t('codexProblem') + codex.problem + '）'),
                    }),
                    // The "no backend registered" explainer belongs to the missing
                    // state only: under a green "Codex 后端可用" its first sentence
                    // is a lie, and the two lines read as a contradiction.
                    ...(codexReady && codex.problem === null ? [] : [jsx('div', { children: t('codexMissingHint') })]),
                  ],
                })
              : jsx('div', { className: C.fieldStackHint, children: t('backendNoteSpawn') }),
            // The one notice a template can still raise, and it is green: the route
            // the live catalog answered with. A template that resolved nothing
            // raises none — see `applyTemplate`.
            templateNote !== null
              ? jsx('div', {
                  className: C.notice + ' ' + C.noticeOk,
                  children: t('templateModelResolved')
                    + (templateNote.detail === '' ? '' : ' ' + templateNote.detail),
                })
              : null,
          ] }),

          // The route is one concept — three selects that only mean anything
          // together — so it gets one row and one label instead of three rows.
          // Absent entirely for Codex: that backend has no DSH LLM route.
          isCodex
            ? null
            : jsxs('div', { className: C.fieldStack, children: [
                jsx('label', { className: C.fieldStackLabel, children: t('fRoute') }),
                jsxs('div', { className: C.routeRow, children: [
                  jsx('select', {
                    className: C.control,
                    style: s.select,
                    'aria-label': t('fProvider'),
                    value: form.provider,
                    onChange: (event) => update({ provider: event.target.value, model: '', reasoningEffort: '' }),
                    children: [jsx('option', { key: '', value: '', children: t('fProvider') + ' —' })].concat(
                      providers.map((entry) => jsx('option', { key: entry.provider, value: entry.provider, children: entry.providerName || entry.provider })),
                    ),
                  }),
                  jsx('select', {
                    className: C.control,
                    style: s.select,
                    'aria-label': t('fModel'),
                    value: form.model,
                    disabled: provider === null,
                    onChange: (event) => update({ model: event.target.value, reasoningEffort: '' }),
                    children: [jsx('option', { key: '', value: '', children: t('fModel') + ' —' })].concat(
                      (provider ? provider.models || [] : []).map((entry) => jsx('option', { key: entry.id, value: entry.id, children: entry.name })),
                    ),
                  }),
                  jsx('select', {
                    className: C.control,
                    style: s.select,
                    'aria-label': t('fEffort'),
                    value: form.reasoningEffort,
                    disabled: efforts.length === 0,
                    onChange: (event) => update({ reasoningEffort: event.target.value }),
                    children: [jsx('option', { key: '', value: '', children: efforts.length === 0 ? t('fEffort') + ' —' : t('effortDefault') })].concat(
                      efforts.map((entry) => jsx('option', { key: entry.id, value: entry.id, children: entry.name })),
                    ),
                  }),
                ] }),
                route !== null
                  ? jsx('div', { className: C.notice + ' ' + (route.state === 'ok' ? C.noticeOk : route.state === 'checking' ? C.noticeNeutral : C.noticeError), children:
                      route.state === 'checking' ? t('routeChecking') : route.state === 'ok' ? t('routeOk') : t('routeBad') + '：' + (route.reason || '') })
                  : null,
              ] }),

          jsxs('div', { className: C.fieldStack, children: [
            jsx('label', { className: C.fieldStackLabel, children: t('fDescription') }),
            jsx('textarea', { style: s.textarea, value: form.description, onChange: (event) => update({ description: event.target.value }) }),
            jsx('div', { className: C.fieldStackHint, children: t('descHint') }),
          ] }),

          jsxs('div', { className: C.fieldStack, children: [
            jsx('label', { className: C.fieldStackLabel, children: t('fInstructions') }),
            jsx('textarea', { style: s.textarea, value: form.instructions, onChange: (event) => update({ instructions: event.target.value }) }),
            jsx('div', { className: C.fieldStackHint, children: t('instructionsHint') }),
          ] }),

          // The same switch as the list and the Skills tab, so "enabled" looks the
          // same everywhere it appears. It was a bare checkbox here.
          jsxs('div', { className: C.fieldStack, children: [
            jsx('label', { className: C.fieldStackLabel, children: t('fEnabled') }),
            jsx('button', {
              type: 'button',
              role: 'switch',
              className: C.switchBtn,
              'aria-checked': form.enabled,
              'aria-label': t('fEnabled'),
              onClick: () => update({ enabled: !form.enabled }),
            }),
          ] }),

          jsxs('div', { className: C.footer, children: [
            jsx('button', { type: 'button', className: C.discard, onClick: onCancel, children: t('cancel') }),
            jsx('button', {
              type: 'button',
              className: C.save,
              // The route is required for a DSH subagent and *not* for a Codex
              // one: it has no route to fill in, and demanding one would make
              // the dialog unsaveable for the only backend that needs nothing.
              disabled: busy
                || form.name.trim() === ''
                || form.description.trim() === ''
                || (!isCodex && (form.provider === '' || form.model === '')),
              onClick: () => { void submit(); },
              children: created ? t('create') : t('save'),
            }),
          ] }),
        ] }),
      });
    }

    // ── injection preview ───────────────────────────────────────────────────

    /**
     * The dialog behind the 查看 button: the literal prompt text.
     *
     * ## Why this is worth a dialog
     *
     * The Profile and Perspective sections are registered against `systemPrompt`
     * and, once registered, they are invisible: they appear in a session
     * transcript and nowhere else. "Is this actually in effect, or is it just a
     * UI?" is therefore a reasonable question with no on-screen answer, and the
     * honest fix is to show the text rather than to ask for trust.
     *
     * The text comes from the Host, composed by the same three functions the
     * prompt sections call — this component renders, it never re-derives. That
     * matters: a preview assembled here from the page's own fields would be a
     * second implementation of the thing it claims to show.
     *
     * ## Three things it must never imply
     *
     * - That the form above is in effect. It is a draft; the sections shown are
     *   the stored ones, and `injectionDirty` says so when they differ.
     * - That the Workspace default is what a live session uses: a session may
     *   hold a `/perspective` override this Workspace-scoped read cannot see.
     * - That an empty body means "nothing configured": the Profile texts load
     *   asynchronously, so an empty composition may be a not-yet-loaded one.
     *
     * @param {object} props - the props.
     * @param {Function} props.t - the locale lookup.
     * @param {{ state: string, value?: any, error?: Error }} props.result - the loaded preview.
     * @param {boolean} props.dirty - whether the form holds unsaved edits.
     * @param {boolean} props.copied - whether the copy just succeeded.
     * @param {Function} props.onCopy - copy the whole composition.
     * @param {Function} props.onClose - dismiss the dialog.
     * @returns {any} the dialog element.
     */
    function InjectionDialog({ t, result, dirty, copied, onCopy, onClose }) {
      const label = (id) => id === 'workspace-profile:context' ? t('injectionSectionContext')
        : id === 'workspace-profile:perspective' ? t('injectionSectionPerspective')
          : t('injectionSectionAgents');

      /**
       * The verdict, composed from the Host's own answer.
       *
       * Derived from `saved.parts` rather than decided again here: the Host is
       * the only place that knows which of the three sections came out non-empty,
       * and a second opinion in the browser is how the page came to disagree with
       * the runtime in the first place. Reported per part, because the expert
       * directory is not gated on a Profile: a Workspace that injects no Profile
       * can still be advertising its Subagents, and calling that "not injected"
       * would be false.
       *
       * @param {any} group - one composition from the Host.
       * @param {string} onboardingStatus - the Workspace's stored status.
       * @returns {{ active: boolean, text: string }|null} the verdict.
       */
      const verdictOf = (group, onboardingStatus) => {
        if (group === null || group === undefined) return null;
        if (group.active !== true) {
          return {
            active: false,
            text: onboardingStatus === 'skipped'
              ? t('injectionOffSkipped')
              : onboardingStatus === 'configured' ? t('injectionNone') : t('injectionOffNoProfile'),
          };
        }
        const named = [];
        if (group.parts.profile) named.push(t('profile'));
        if (group.parts.perspective) named.push(t('perspective'));
        if (group.parts.agents) named.push(t('injectionSectionAgents'));
        return { active: true, text: named.join(' + ') };
      };

      /**
       * What went wrong, in the terms the reader can act on.
       *
       * A 404 naming this exact method means the client bundle is newer than the
       * Host: the browser half hot-reloads, the Host half does not. Reporting the
       * raw transport failure would read as "the plugin is broken" when the
       * actual fix is to restart DSH.
       *
       * @returns {string} the message to show.
       */
      const failureText = () => {
        const message = result.error ? result.error.message : '';
        if (/previewInjection/.test(message) && /(404|transport failure)/i.test(message)) {
          return t('injectionNeedsRestart');
        }
        return t('injectionLoadFailed') + '：' + message;
      };

      // Computed once, and only for a loaded answer: an error or an unavailable
      // read has no verdict to give, and showing one would be inventing it.
      const verdict = result.state === 'ready' && result.value && result.value.available !== false
        ? verdictOf(result.value.saved, result.value.onboardingStatus)
        : null;

      /**
       * One composition — the stored one, or the one a save would produce.
       *
       * Empty sections are shown rather than dropped. Hiding them would make
       * "this part is not injected" indistinguishable from "this part does not
       * exist", which is the confusion this dialog exists to remove.
       */
      const render = (group, heading) => jsxs('div', { style: s.previewGroup, children: [
        jsx('div', { style: s.previewHead, children: [
          jsx('strong', { style: { fontSize: FONT_SECONDARY }, children: heading }),
          jsx('span', { style: s.hint, children: group.totalChars + ' ' + t('injectionChars') }),
        ] }),
        group.active
          ? null
          : jsx('div', { style: s.notice(WARN), children: t('injectionNone') }),
        ...group.sections.map((section) => jsxs('div', { key: section.id, style: s.previewSection, children: [
          jsxs('div', { style: s.previewHead, children: [
            jsx('span', { style: { fontSize: FONT_SECONDARY, color: LABEL_SECONDARY }, children: label(section.id) }),
            // The stable section name, monospaced: it is what a session
            // transcript and this dialog have in common, so it is worth being
            // able to compare them letter for letter.
            jsx('span', { className: C.subKey, children: section.id }),
            jsx('span', { style: s.hint, children: section.chars + ' ' + t('injectionChars') }),
          ] }),
          jsx('pre', { style: s.previewText, children: section.text === '' ? t('injectionEmptySection') : section.text }),
        ] })),
      ] });

      return jsx('div', {
        className: C.modalBackdrop,
        onClick: (event) => { if (event.target === event.currentTarget) onClose(); },
        children: jsxs('div', { className: C.modalPanel, 'data-workspace-profile': 'injection-dialog', children: [
          jsx('h3', { className: C.modalTitle, children: t('injectionTitle') }),

          result.state === 'loading'
            ? jsx('div', { style: s.empty, children: t('loading') })
            : result.state === 'error'
            ? jsxs('div', { style: s.previewGroup, children: [
                jsx('div', { style: s.notice(ERROR), children: failureText() }),
              ] })
            : result.value && result.value.available === false
            ? jsx('div', { style: s.notice(ERROR), children: t('injectionUnavailable') + (result.value.message || '') })
            : jsxs(Fragment, { children: [
                verdict !== null && verdict !== undefined
                  ? jsxs('div', { style: s.previewHead, children: [
                      jsx(Pill, { colour: verdict.active ? SUCCESS : WARN, children: verdict.active ? t('injectionOn') : t('injectionOff') }),
                      jsx('span', { style: { fontSize: FONT_SECONDARY }, children: verdict.text }),
                    ] })
                  : null,
                dirty ? jsx('div', { style: s.notice(WARN), children: t('injectionDirty') }) : null,
                result.value.textsLoaded === false
                  ? jsx('div', { style: s.notice(WARN), children: t('injectionNotLoaded') })
                  : null,

                render(result.value.saved, t('injectionStoredTitle')),

                result.value.draft === null || result.value.draft === undefined
                  ? null
                  : result.value.draft.valid === false
                  ? jsxs('div', { style: s.previewGroup, children: [
                      jsx('div', { style: s.previewHead, children: jsx('strong', { style: { fontSize: FONT_SECONDARY }, children: t('injectionDraftTitle') }) }),
                      jsx('div', { style: s.notice(WARN), children: t('injectionDraftInvalid') + result.value.draft.invalidReason }),
                    ] })
                  : render(result.value.draft, t('injectionDraftTitle')),

                jsx('div', { style: s.hint, children: t('injectionOverrideNote') }),
              ] }),

          jsxs('div', { className: C.footer, children: [
            jsx('button', { type: 'button', className: C.discard, onClick: onClose, children: t('injectionClose') }),
            jsx('button', {
              type: 'button',
              className: C.discard,
              disabled: result.state !== 'ready' || !result.value || result.value.available === false,
              onClick: onCopy,
              children: copied ? t('injectionCopied') : t('injectionCopy'),
            }),
          ] }),
        ] }),
      });
    }

    // ── registration ────────────────────────────────────────────────────────

    /**
     * Register the section once the Remote namespace is mounted.
     *
     * The namespace is the whole reason this package exists — without it there is
     * nothing to configure — so parking on it means a `dsh-workspace-profile`
     * whose Host half is absent shows no section rather than an error panel.
     */
    function apply(ctx) {
      // Mount the Remote contribution FIRST. Nothing below can resolve until the
      // namespace exists, and a pending `ctx.inject` reports nothing at all —
      // the panel simply never appears.
      ctx.effect(async () => {
        const dispose = await ctx.remote.$mount(TYPERT_REMOTE);
        return () => dispose();
      }, 'workspace-profile: mount the Remote namespace');

      ctx.effect(() => ctx.locale.register(NS, DICTS), 'workspace-profile: copy dictionaries');
      const t = ctx.locale.bind(NS);

      ctx.inject(['remote.workspaceProfile'], (scoped) => {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: SECTION_ID,
          order: SECTION_ORDER,
          label: () => t('nav'),
          // The factory's RETURN VALUE is spread into the body's props, so every
          // prop the body reads has to be named here — `locale` included. A
          // missing one is not a type error at runtime; it is `undefined` until
          // the first render that dereferences it, which is why the section's
          // error boundary exists.
          inject: () => ({
            remote: scoped.remote.workspaceProfile,
            locale: ctx.locale,
            validateRoute: (provider, model, reasoningEffort) => scoped.remote.workspaceProfile.validateRoute(
              { provider, model, reasoningEffort },
            ),
          }),
        }, (props) => jsx(SectionBoundary, {
          children: jsx(WorkspaceCompositionSection, props),
        })));

        // ── the `@子代理` source ──────────────────────────────────────────────
        //
        // Nested inside this callback on purpose, and that is not tidiness: the
        // namespace the source reads is the one **this** callback was handed. Read
        // as `ctx.remote.workspaceProfile` from an independent `ctx.inject`, the
        // source can be constructed before the mount above has resolved, and would
        // then hold `undefined` for the lifetime of the page — every `@` reading a
        // namespace that does not exist, with the failure swallowed into an empty
        // menu.
        //
        // Gated on the trigger registry because it is optional: a composition
        // without `ui-input-trigger` has no `@` menu at all, and the Settings
        // section above must keep working there. Same for `remote.commands` — it is
        // what a mention ultimately *runs*, so without it a source could offer
        // candidates it could not dispatch, and a menu whose picks do nothing is
        // worse than no menu.
        const profileRemote = scoped.remote.workspaceProfile;
        ctx.inject(['inputTriggers', 'remote.commands'], (mentionCtx) => {
          const source = createMentionSource({
            remote: profileRemote,
            commands: mentionCtx.remote.commands,
            t,
          });
          ctx.effect(() => mentionCtx.inputTriggers.registerSource(source), 'workspace-profile: @ subagent source');

          // Two invalidations the source cannot see for itself.
          //
          // `settings/document-updated` fires for *any* write to this settings
          // namespace, including one made in another window or tab, so a Subagent
          // added elsewhere shows up in the `@` menu without a reload.
          ctx.remote.$on('settings/document-updated', (ns) => {
            if (ns === MENTION_SETTINGS_NAMESPACE) invalidateMentions();
          });
          // `connection/reset` is the platform's own statement that wire-derived
          // caches must repull: a reconnected generation may be a different Host
          // with different registered providers and a different stored document.
          ctx.on('connection/reset', () => invalidateMentions());
        });
      });
    }

    exports.apply = apply;
    exports.inject = ['slots', 'remote', 'locale'];
    exports.SECTION_ID = SECTION_ID;
    exports.WorkspaceCompositionSection = WorkspaceCompositionSection;
    exports.unwrap = unwrap;
    exports.failureOf = failureOf;
    exports.labelOf = labelOf;
    exports.DICTS = DICTS;
    exports.TYPERT_REMOTE = TYPERT_REMOTE;
    exports.INVOCATIONS = INVOCATIONS;
    // Exported so the tests can assert the templates as data: the dialog that
    // renders them is closed in every static tree, so nothing else can see them.
    exports.SUBAGENT_TEMPLATES = SUBAGENT_TEMPLATES;
    exports.templateFormPatch = templateFormPatch;
    exports.resolveTemplateRoute = resolveTemplateRoute;
    exports.matchModelSpec = matchModelSpec;
    // The `@` source's pure parts, exported for the same reason the templates
    // are: the composer that would exercise them only exists in a real browser,
    // so a rule living only inside the registered source cannot be observed from
    // a static tree. `createMentionSource` itself is exported so the harness can
    // register it against a fake trigger registry and drive it as the platform
    // would.
    exports.createMentionSource = createMentionSource;
    exports.mentionRows = mentionRows;
    exports.matchMentionReference = matchMentionReference;
    exports.parseMentionLine = parseMentionLine;
    exports.mentionMatches = mentionMatches;
    exports.invalidateMentions = invalidateMentions;
    exports.MENTION_SOURCE_NAME = MENTION_SOURCE_NAME;
    exports.MENTION_TRIGGER = MENTION_TRIGGER;
    return module.exports;
  },
});
