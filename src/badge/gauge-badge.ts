import { LitElement, TemplateResult, html, css, nothing, PropertyValues, svg } from "lit";
import { HomeAssistant } from "../ha/types";
import { ModernCircularGaugeBadgeConfig } from "./gauge-badge-config";
import { customElement, property, state } from "lit/decorators.js";
import { NUMBER_ENTITY_DOMAINS, DEFAULT_MIN, DEFAULT_MAX } from "../const";
import { getNumberFormatOptions, formatNumber } from "../utils/format_number";
import { registerCustomBadge } from "../utils/custom-badges";
import { HassEntity, UnsubscribeFunc } from "home-assistant-js-websocket";
import { styleMap } from "lit/directives/style-map.js";
import { svgArc, computeSegments, getAngle, renderPath, renderColorSegments, currentDashArc } from "../utils/gauge";
import { classMap } from "lit/directives/class-map.js";
import { ActionHandlerEvent } from "../ha/data/lovelace";
import { hasAction } from "../ha/panels/lovelace/common/has-action";
import { handleAction } from "../ha/handle-action";
import { actionHandler } from "../utils/action-handler-directive";
import { mdiAlertCircle } from "@mdi/js";
import { RenderTemplateResult, subscribeRenderTemplate } from "../ha/data/ws-templates";
import { ifDefined } from "lit/directives/if-defined.js";
import { isTemplate } from "../utils/template";
import { SegmentsConfig } from "../card/type";
import getEntityPictureUrl from "../utils/entity-picture";

const MAX_ANGLE = 270;
const ROTATE_ANGLE = 360 - MAX_ANGLE / 2 - 90;
const RADIUS = 42;

registerCustomBadge({
  type: "modern-circular-gauge-badge",
  name: "Modern Circular Gauge Badge",
  description: "Modern circular gauge badge",
});

const path = svgArc({
  x: 0,
  y: 0,
  start: 0,
  end: MAX_ANGLE,
  r: RADIUS,
});

@customElement("modern-circular-gauge-badge")
export class ModernCircularGaugeBadge extends LitElement {
  @property({ attribute: false }) public hass!: HomeAssistant;
  @state() private _config?: ModernCircularGaugeBadgeConfig;

  @state() private _templateResults?: Partial<Record<string, RenderTemplateResult | undefined>> = {};

  @state() private _unsubRenderTemplates?: Map<string, Promise<UnsubscribeFunc>> = new Map();

  public static async getStubConfig(hass: HomeAssistant): Promise<ModernCircularGaugeBadgeConfig> {
    const entities = Object.keys(hass.states);
    const numbers = entities.filter((e) =>
      NUMBER_ENTITY_DOMAINS.includes(e.split(".")[0])
    );
    return {
      type: "custom:modern-circular-gauge-badge",
      entity: numbers[0],
    };
  }

  public static async getConfigElement(): Promise<HTMLElement> {
    await import("./gauge-badge-editor");
    return document.createElement("modern-circular-gauge-badge-editor");
  }

  setConfig(config: ModernCircularGaugeBadgeConfig): void {
    if (!config.entity) {
      throw new Error("Entity must be specified");
    }

    this._config = { min: DEFAULT_MIN, max: DEFAULT_MAX, show_state: true, ...config };
  }

  public connectedCallback() {
    super.connectedCallback();
    this._tryConnect();
  }

  public disconnectedCallback() {
    super.disconnectedCallback();
    this._tryDisconnect();
  }

  protected updated(changedProps: PropertyValues): void {
    super.updated(changedProps);
    if (!this._config || !this.hass) {
      return;
    }

    this._tryConnect();
  }

  private async _tryConnect(): Promise<void> {
    const templates = {
      entity: this._config?.entity,
      name: this._config?.name,
      icon: this._config?.icon,
      min: this._config?.min,
      max: this._config?.max,
      segments: this._config?.segments,
      stateText: this._config?.state_text,
    };

    Object.entries(templates).forEach(([key, value]) => {
      if (typeof value == "string") {
        this._tryConnectKey(key, value);
      } else if (key == "segments") {
        const segmentsStringified = JSON.stringify(value);
        this._tryConnectKey(key, segmentsStringified);
      }
    });
  }

  private async _tryConnectKey(key: string, templateValue: string): Promise<void> {
    if (
      this._unsubRenderTemplates?.get(key) !== undefined ||
      !this.hass ||
      !this._config ||
      !isTemplate(templateValue)
    ) {
      return;
    }

    try {
      const sub = subscribeRenderTemplate(
        this.hass.connection,
        (result) => {
          if ("error" in result) {
            return;
          }
          this._templateResults = {
            ...this._templateResults,
            [key]: result,
          };
        },
        {
          template: templateValue as string || "",
          variables: {
            config: this._config,
            user: this.hass.user!.name,
          },
          strict: true,
        }
      );
      this._unsubRenderTemplates?.set(key, sub);
      await sub;
    } catch (e: any) {
      const result = {
        result: templateValue as string || "",
        listeners: { all: false, domains: [], entities: [], time: false },
      };
      this._templateResults = {
        ...this._templateResults,
        [key]: result,
      };
      this._unsubRenderTemplates?.delete(key);
    }
  }

  private async _tryDisconnect(): Promise<void> {
    const templates = {
      entity: this._config?.entity,
      name: this._config?.name,
      icon: this._config?.icon,
      min: this._config?.min,
      max: this._config?.max,
      segments: this._config?.segments,
      stateText: this._config?.state_text,
    };
    
    Object.entries(templates).forEach(([key, _]) => {
      this._tryDisconnectKey(key);
    });
  }

  private async _tryDisconnectKey(key: string): Promise<void> {
    const unsubRenderTemplate = this._unsubRenderTemplates?.get(key);
    if (!unsubRenderTemplate) {
      return;
    }

    try {
      const unsub = await unsubRenderTemplate;
      unsub();
      this._unsubRenderTemplates?.delete(key);
    } catch (e: any) {
      if (e.code === "not_found" || e.code === "template_error") {

      } else {
        throw e;
      }
    }
  }

  get hasAction() {
    return (
      !this._config?.tap_action ||
      hasAction(this._config?.tap_action) ||
      hasAction(this._config?.hold_action) ||
      hasAction(this._config?.double_tap_action)
    );
  }

  protected render(): TemplateResult {
    if (!this.hass || !this._config) {
      return html``;
    }

    const stateObj = this.hass.states[this._config.entity];
    const templatedState = this._templateResults?.entity?.result;    

    if (!stateObj && templatedState === undefined) {
      if (isTemplate(this._config.entity)) {
        return this._renderWarning();
      } else {
        return this._renderWarning(this._config.entity, this.hass.localize("ui.badge.entity.not_found"), undefined, "error", mdiAlertCircle);
      }
    }

    const numberState = Number(templatedState ?? stateObj.attributes[this._config.attribute!] ?? stateObj.state);
    const icon = this._templateResults?.icon?.result ?? this._config.icon;

    if (stateObj?.state === "unavailable") {
      return this._renderWarning(this._templateResults?.name?.result ?? (isTemplate(String(this._config.name)) ? "" : this._config.name) ?? stateObj.attributes.friendly_name ?? '', this.hass.localize("state.default.unavailable"), stateObj, "warning", icon);
    }

    if (isNaN(numberState)) {
      return this._renderWarning(this._templateResults?.name?.result ?? (isTemplate(String(this._config.name)) ? "" : this._config.name) ?? stateObj.attributes.friendly_name ?? '', "NaN", stateObj, "warning", icon);
    }

    const min = Number(this._templateResults?.min?.result ?? this._config.min) ?? DEFAULT_MIN;
    const max = Number(this._templateResults?.max?.result ?? this._config.max) ?? DEFAULT_MAX;

    const attributes = stateObj?.attributes ?? undefined;

    const current = this._config.needle ? undefined : currentDashArc(numberState, min, max, RADIUS, this._config.start_from_zero);
    const state = templatedState ?? stateObj.attributes[this._config.attribute!] ?? stateObj.state;

    const stateOverride = this._templateResults?.stateText?.result ?? (isTemplate(String(this._config.state_text)) ? "" : (this._config.state_text || undefined));
    const unit = this._config.show_unit ?? true ? (this._config.unit ?? stateObj?.attributes.unit_of_measurement) || "" : "";

    const formatOptions = { ...getNumberFormatOptions({ state, attributes } as HassEntity, this.hass.entities[stateObj?.entity_id]) };
    if (this._config.decimals !== undefined) {
      formatOptions.minimumFractionDigits = this._config.decimals;
      formatOptions.maximumFractionDigits = this._config.decimals;
    }

    const entityState = stateOverride ?? formatNumber(state, this.hass.locale, formatOptions) ?? templatedState;

    const showIcon = this._config.show_icon ?? true;

    const imageUrl = this._config.show_entity_picture
      ? getEntityPictureUrl(this.hass, stateObj)
      : undefined;

    const name = this._templateResults?.name?.result ?? (isTemplate(String(this._config.name)) ? "" : this._config.name) ?? stateObj?.attributes.friendly_name ?? "";
    const label = this._config.show_name && showIcon && this._config.show_state ? name : undefined;
    const content = showIcon && this._config.show_state ? `${entityState} ${unit}` : this._config.show_name ? name : undefined;

    const segments = (this._templateResults?.segments?.result as unknown) as SegmentsConfig[] ?? this._config.segments;

    const gaugeBackgroundStyle = this._config.gauge_background_style;
    const gaugeForegroundStyle = this._config.gauge_foreground_style;

    return html`
    <ha-badge
      .type=${this.hasAction ? "button" : "badge"}
      @action=${this._handleAction}
      .actionHandler=${actionHandler({
        hasHold: hasAction(this._config.hold_action),
        hasDoubleClick: hasAction(this._config.double_tap_action),
      })}
      .iconOnly=${content === undefined}
      style=${styleMap({ "--gauge-color": gaugeForegroundStyle?.color && gaugeForegroundStyle?.color != "adaptive" ? gaugeForegroundStyle?.color : computeSegments(numberState, segments, this._config.smooth_segments, this), "--gauge-stroke-width": gaugeForegroundStyle?.width ? `${gaugeForegroundStyle?.width}px` : undefined })}
      .label=${label}
    >
      <div class=${classMap({ "container": true, "icon-only": content === undefined })} slot="icon">
        <svg class="gauge" viewBox="-50 -50 100 100">
          <g transform="rotate(${ROTATE_ANGLE})">
            <defs>
            ${this._config.needle ? svg`
              <mask id="needle-mask">
                ${renderPath("arc", path, undefined, styleMap({ "stroke": "white", "stroke-width": gaugeBackgroundStyle?.width ? `${gaugeBackgroundStyle?.width}px` : undefined  }))}
                <circle cx="42" cy="0" r=${gaugeForegroundStyle?.width ? gaugeForegroundStyle?.width - 2 : 12} fill="black" transform="rotate(${getAngle(numberState, min, max)})"/>
              </mask>
              ` : nothing}
              <mask id="gradient-path">
                ${renderPath("arc", path, undefined, styleMap({ "stroke": "white", "stroke-width": gaugeBackgroundStyle?.width ? `${gaugeBackgroundStyle?.width}px` : undefined }))}
              </mask>
              <mask id="gradient-current-path">
                ${current ? renderPath("arc current", path, current, styleMap({ "stroke": "white", "visibility": numberState <= min && min >= 0 ? "hidden" : "visible" })) : nothing}
              </mask>
            </defs>
            <g mask="url(#needle-mask)">
              <g class="background" style=${styleMap({ "opacity": this._config.gauge_background_style?.opacity,
                "--gauge-stroke-width": this._config.gauge_background_style?.width ? `${this._config.gauge_background_style?.width}px` : undefined })}>
                ${renderPath("arc clear", path, undefined, styleMap({ "stroke": gaugeBackgroundStyle?.color && gaugeBackgroundStyle?.color != "adaptive" ? gaugeBackgroundStyle?.color : undefined }))}
                ${this._config.segments && (this._config.needle || this._config.gauge_background_style?.color == "adaptive") ? svg`
                <g class="segments" mask=${ifDefined(this._config.smooth_segments ? "url(#gradient-path)" : undefined)}>
                  ${renderColorSegments(segments, min, max, RADIUS, this._config?.smooth_segments)}
                </g>`
                : nothing
                }
              </g>
            </g>
          ${this._config.needle ? svg`
            <circle class="needle" cx="42" cy="0" r=${gaugeForegroundStyle?.width ? gaugeForegroundStyle?.width / 2 : 7} transform="rotate(${getAngle(numberState, min, max)})"/>
          ` : nothing}
          ${current ? gaugeForegroundStyle?.color == "adaptive" ? svg`
            <g class="foreground-segments" mask="url(#gradient-current-path)" style=${styleMap({ "opacity": gaugeForegroundStyle?.opacity })}>
              ${renderColorSegments(segments, min, max, RADIUS, this._config?.smooth_segments)}
            </g>
            ` : renderPath("arc current", path, current, styleMap({ "visibility": numberState <= min && min >= 0 ? "hidden" : "visible", "opacity": gaugeForegroundStyle?.opacity })) : nothing}
          </g>
        </svg>
        ${showIcon
          ? imageUrl
            ? html`<img src=${imageUrl} aria-hidden/>`
            : html`
            <ha-state-icon
              .hass=${this.hass}
              .stateObj=${stateObj}
              .icon=${icon}
            ></ha-state-icon>`
          : nothing}
        ${this._config.show_state && !showIcon
          ? html`
          <svg class="state" viewBox="-50 -50 100 100">
            <text x="0" y="0" class="value" style=${styleMap({ "font-size": this._calcStateSize(entityState) })}>
              ${entityState}
              ${this._config.show_unit ?? true ? svg`
              <tspan class="unit" dx="-4" dy="-6">${unit}</tspan>
              ` : nothing}
            </text>
          </svg>
          ` : nothing}
      </div>
      ${content}
    </ha-badge>
    `;
  }

  private _renderWarning(label?: string, content?: string, stateObj?: HassEntity, badgeClass?: string, icon?: string): TemplateResult {
    return html`
    <ha-badge
      .type=${this.hasAction ?? stateObj != undefined ? "button" : "badge"}
      @action=${ifDefined(stateObj ? this._handleAction : undefined)}
      .actionHandler=${actionHandler({
        hasHold: hasAction(this._config?.hold_action),
        hasDoubleClick: hasAction(this._config?.double_tap_action),
      })}
      class="${ifDefined(badgeClass)}"
      .label=${label} 
      >
      <div class=${classMap({ "container": true, "icon-only": content === undefined })} slot="icon">
        <svg class="gauge" viewBox="-50 -50 100 100">
          <g transform="rotate(${ROTATE_ANGLE})">
            ${renderPath("arc clear", path)}
          </g>
        </svg>
        ${stateObj ? html`
        <ha-state-icon
          slot="icon"
          .hass=${this.hass}
          .stateObj=${stateObj}
          .icon=${icon}
        ></ha-state-icon>
        ` : html`
        <ha-svg-icon
          slot="icon"
          .path=${icon}
        ></ha-svg-icon>
        `}
      </div>
      ${content}
    </ha-badge>
    `;
  }

  private _calcStateSize(state: string): string {
    const initialSize = 25;
    if (state.length >= 4) {
      return `${initialSize - (state.length - 3)}px`
    }
    return `${initialSize}px`;
  }

  private _handleAction(ev: ActionHandlerEvent) {
    const config = {
      ...this._config,
      entity: isTemplate(this._config?.entity ?? "") ? "" : this._config?.entity
    };

    handleAction(this, this.hass!, config, ev.detail.action!);
  }

  static get styles() {
    return css`
    :host {
      --gauge-color: var(--primary-color);
      --gauge-stroke-width: 14px;
    }

    .badge::slotted([slot=icon]) {
      margin-left: 0;
      margin-right: 0;
      margin-inline-start: 0;
      margin-inline-end: 0;
    }

    
    .state {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      right: 0;
      text-anchor: middle;
    }

    .value {
      font-size: 21px;
      fill: var(--primary-text-color);
      dominant-baseline: middle;
    }

    .unit {
      font-size: .43em;
      opacity: 0.6;
    }

    .container {
      display: flex;
      justify-content: center;
      align-items: center;
      position: relative;
      container-type: normal;
      container-name: container;
      width: calc(var(--ha-badge-size, 36px) - 2px);
      height: calc(var(--ha-badge-size, 36px) - 2px);
      margin-left: -12px;
      margin-inline-start: -12px;
      pointer-events: none;
    }

    .container img {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      object-fit: cover;
      overflow: hidden;
      margin-right: 0;
      margin-inline-end: 0;
    }
    
    .container.icon-only {
      margin-left: 0;
      margin-inline-start: 0;
    }

    .gauge {
      position: absolute;
    }

    .segment {
      fill: none;
      stroke-width: var(--gauge-stroke-width);
      filter: brightness(100%);
    }

    .segments {
      opacity: 0.45;
    }

    ha-badge {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      --badge-color: var(--gauge-color);
    }

    ha-badge.error {
      --badge-color: var(--red-color);
    }

    ha-badge.warning {
      --badge-color: var(--state-unavailable-color);
    }

    svg {
      width: 100%;
      height: 100%;
      display: block;
    }
    g {
      fill: none;
    }
    .arc {
      fill: none;
      stroke-linecap: round;
      stroke-width: var(--gauge-stroke-width);
    }

    .arc.clear {
      stroke: var(--primary-background-color);
    }

    .arc.current {
      stroke: var(--gauge-color);
      transition: all 1s ease 0s;
    }

    .needle {
      fill: var(--gauge-color);
      stroke: var(--gauge-color);
      transition: all 1s ease 0s;
    }

    circle {
      transition: all 1s ease 0s;
    }
    `
  }
}