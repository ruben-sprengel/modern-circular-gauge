import { html, LitElement, TemplateResult, css, nothing, PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { ActionHandlerEvent } from "../ha/data/lovelace";
import { hasAction } from "../ha/panels/lovelace/common/has-action";
import { svgArc, computeSegments, renderPath } from "../utils/gauge";
import { registerCustomCard } from "../utils/custom-cards";
import type { GaugeElementConfig, ModernCircularGaugeConfig, SecondaryEntity, SegmentsConfig, TertiaryEntity } from "./type";
import { LovelaceLayoutOptions, LovelaceGridOptions } from "../ha/data/lovelace";
import { handleAction } from "../ha/handle-action";
import { HomeAssistant } from "../ha/types";
import { HassEntity, UnsubscribeFunc } from "home-assistant-js-websocket";
import { classMap } from "lit/directives/class-map.js";
import { styleMap } from "lit/directives/style-map.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { actionHandler } from "../utils/action-handler-directive";
import { DEFAULT_MIN, DEFAULT_MAX, NUMBER_ENTITY_DOMAINS, GAUGE_TYPE_ANGLES, MAX_ANGLE, RADIUS, INNER_RADIUS, TERTIARY_RADIUS, TIMESTAMP_STATE_DOMAINS } from "../const";
import { RenderTemplateResult, subscribeRenderTemplate } from "../ha/data/ws-templates";
import { isTemplate } from "../utils/template";
import "../components/modern-circular-gauge-element";
import "../components/modern-circular-gauge-state";
import "../components/modern-circular-gauge-icon";
import { computeStateDomain } from "../ha/common/entity/compute_state_domain";
import durationToSeconds from "../ha/common/datetime/duration_to_seconds";
import { getTimerRemainingSeconds, getTimestampRemainingSeconds } from "../utils/timer_timestamp_utils";

registerCustomCard({
  type: "modern-circular-gauge",
  name: "Modern Circular Gauge",
  description: "Modern circular gauge",
});

@customElement("modern-circular-gauge")
export class ModernCircularGauge extends LitElement {
  @property({ attribute: false }) public hass!: HomeAssistant;
  @state() private _config?: ModernCircularGaugeConfig;

  @state() private _hasSecondary?: boolean = false;

  @state() private _templateResults?: Partial<Record<string, RenderTemplateResult | undefined>> = {};

  @state() private _unsubRenderTemplates?: Map<string, Promise<UnsubscribeFunc>> = new Map();

  @state() private _stateMargin?: number;

  @state() private _inCardPicker?: boolean;

  public static async getConfigElement(): Promise<HTMLElement> {
    await import("./mcg-editor");
    return document.createElement("modern-circular-gauge-editor");
  }

  public static async getStubConfig(hass: HomeAssistant): Promise<ModernCircularGaugeConfig> {
    const entities = Object.keys(hass.states);
    const numbers = entities.filter((e) =>
      NUMBER_ENTITY_DOMAINS.includes(e.split(".")[0])
    );
    return {
      type: "custom:modern-circular-gauge",
      entity: numbers[0],
    };
  }

  setConfig(config: ModernCircularGaugeConfig): void {
    if (!config.entity) {
      throw new Error("Entity must be specified");
    }
    
    let secondary = config.secondary;

    if (secondary === undefined && config.secondary_entity !== undefined) {
        secondary = config.secondary_entity;
    }
    
    if (typeof secondary === "object") {
        const template = secondary.template || "";
        if (template.length > 0) {
            secondary = template;
        }

        let secondaryGaugeForegroundStyle = (secondary as SecondaryEntity).gauge_foreground_style;
        if (!secondaryGaugeForegroundStyle) {
          if ((secondary as SecondaryEntity).gauge_width !== undefined) {
            secondaryGaugeForegroundStyle = { width: (secondary as SecondaryEntity).gauge_width };
            secondary = { ...(secondary as SecondaryEntity), gauge_foreground_style: secondaryGaugeForegroundStyle };
          }
        }
    }

    let gaugeForegroundStyle = config.gauge_foreground_style;

    if (!gaugeForegroundStyle) {
      if (config.gauge_width !== undefined) {
        gaugeForegroundStyle = { width: config.gauge_width };
        config = { ...config, gauge_foreground_style: gaugeForegroundStyle };
      }
    }

    this._config = { min: DEFAULT_MIN, show_header: true, show_state: true, ...config, secondary: secondary, secondary_entity: undefined };
  }

  public connectedCallback() {
    super.connectedCallback();
    this._inCardPicker = this.parentElement?.classList.contains("preview");
    this._tryConnect();
  }

  public disconnectedCallback() {
    super.disconnectedCallback();
    this._tryDisconnect();
  }

  protected firstUpdated(_changedProperties: PropertyValues): void {
    this._stateMargin = this._calcStateMargin();
  }

  protected updated(changedProps: PropertyValues): void {
    super.updated(changedProps);
    if (!this._config || !this.hass) {
      return;
    }

    this._tryConnect();
  }

  private _hasCardAction() {
    return (!this._config?.tap_action ||
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
        return this._renderWarning(this._config.entity, undefined, undefined, "mdi:help");
      }
    }
    
    const icon = this._templateResults?.icon?.result ?? this._config.icon;
    
    if (stateObj?.state === "unavailable") {
      return this._renderWarning(this._templateResults?.name?.result ?? (isTemplate(String(this._config.name)) ? "" : this._config.name) ?? stateObj.attributes.friendly_name ?? '', this.hass.localize("state.default.unavailable"), stateObj, icon);
    }
    
    const domain = computeStateDomain(stateObj);
    let secondsUntil: number | undefined;

    if (stateObj?.attributes.device_class === "timestamp" ||
      TIMESTAMP_STATE_DOMAINS.includes(domain)
    ) {
      secondsUntil = getTimestampRemainingSeconds(stateObj);
    }

    let timerDuration: number | undefined;

    if (domain === "timer") {
      timerDuration = durationToSeconds(stateObj.attributes?.duration ?? "00:00");
      secondsUntil = getTimerRemainingSeconds(stateObj);
    }

    const numberState = Number(templatedState ?? secondsUntil ?? stateObj.attributes[this._config.attribute!] ?? stateObj.state);

    if (isNaN(numberState)) {
      return this._renderWarning(this._templateResults?.name?.result ?? (isTemplate(String(this._config.name)) ? "" : this._config.name) ?? stateObj.attributes.friendly_name ?? '', "NaN", stateObj, icon);
    }

    const attributes = stateObj?.attributes ?? undefined;

    const unit = this._config.unit ?? stateObj?.attributes.unit_of_measurement;

    const min = Number(this._templateResults?.min?.result ?? this._config.min) || DEFAULT_MIN;
    const max = Number(this._templateResults?.max?.result ?? this._config.max ?? timerDuration) || DEFAULT_MAX;

    const stateOverride = this._templateResults?.stateText?.result ?? (isTemplate(String(this._config.state_text)) ? "" : (this._config.state_text || undefined));

    const iconCenter = !(this._config.show_state ?? false) && (this._config.show_icon ?? true);
    const segments = (this._templateResults?.segments?.result as unknown) as SegmentsConfig[] ?? this._config.segments;
    const segmentsLabel = this._getSegmentLabel(numberState, segments);

    const halfStateBig = this._config?.gauge_type == "half" && typeof this._config.secondary != "string" && this._config.secondary?.state_size == "big";

    return html`
    <ha-card
      class="${classMap({
        "flex-column-reverse": this._config.header_position == "top",
        "action": this._hasCardAction(),
        "icon-center": iconCenter
       })}"
      @action=${this._handleAction}
      .actionHandler=${actionHandler({
        hasHold: hasAction(this._config.hold_action),
        hasDoubleClick: hasAction(this._config.double_tap_action),
      })}
      tabindex=${ifDefined(
        !this._config.tap_action || hasAction(this._config.tap_action)
        ? "0"
        : undefined
      )}
    >
      ${this._config.show_header ? html`
      <div class="header" style=${styleMap({ "--gauge-header-font-size": this._config.header_font_size ? `${this._config.header_font_size}px` : undefined,
        "transform": this._config.header_offset ? `translate(0, ${this._config.header_offset}px)` : undefined })}>
        <p class="name">
          ${this._templateResults?.name?.result ?? (isTemplate(String(this._config.name)) ? "" : this._config.name) ?? (attributes ? attributes.friendly_name : "")}
        </p>
      </div>
      ` : nothing}
      <div
        class="container${classMap({ "dual-gauge": (typeof this._config.secondary != "string" && this._config.secondary?.show_gauge == "inner") || (typeof this._config.tertiary != "string" && this._config.tertiary?.show_gauge == "inner"),
          "half-gauge": this._config.gauge_type == "half", "full-gauge": this._config.gauge_type == "full" })}"
        style=${styleMap({ "--full-gauge-padding": this._config.show_header ? undefined : "0",
          "--gauge-color": this._config.gauge_foreground_style?.color && this._config.gauge_foreground_style?.color != "adaptive" ? this._config.gauge_foreground_style?.color : computeSegments(numberState, segments, this._config.smooth_segments, this) })}
      >
        <div class="gauge-container">
          <modern-circular-gauge-element
            .min=${min}
            .max=${max}
            .value=${numberState}
            .radius=${this._config.gauge_radius ?? RADIUS}
            .gaugeType=${this._config.gauge_type}
            .segments=${segments}
            .smoothSegments=${this._config.smooth_segments}
            .foregroundStyle=${this._config.gauge_foreground_style}
            .backgroundStyle=${this._config.gauge_background_style}
            .needle=${this._config.needle}
            .startFromZero=${this._config.start_from_zero}
            .rotateGauge=${this._config.rotate_gauge}
          ></modern-circular-gauge-element>
          ${typeof this._config.secondary != "string" ? 
          this._config.secondary?.show_gauge && this._config.secondary?.show_gauge != "none" ?
          this._renderSecondaryGauge()
          : nothing
          : nothing}
          ${typeof this._config.tertiary != "string" ? 
          this._config.tertiary?.show_gauge && this._config.tertiary?.show_gauge != "none" ?
          this._renderTertiaryRing()
          : nothing
          : nothing}
        </div>
        <div class="gauge-state">
          ${this._config.show_state ? html`
          <modern-circular-gauge-state
            class=${classMap({ "preview": this._inCardPicker! })}
            style=${styleMap({ "--state-text-color": this._config.adaptive_state_color ? "var(--gauge-color)" : undefined , "--state-font-size-override": this._config.state_font_size ? `${this._config.state_font_size}px` : (halfStateBig ? `15px` : undefined) })}
            .hass=${this.hass}
            .stateObj=${stateObj}
            .entityAttribute=${this._config.attribute}
            .stateOverride=${(segmentsLabel || stateOverride) ?? templatedState}
            .unit=${unit}
            .gaugeType=${this._config.gauge_type}
            .verticalOffset=${typeof this._config.secondary != "string" && this._config.secondary?.state_size == "big" ? -14 : this._config.gauge_type == "half" ? (this._hasSecondary ? -15 : -10) : 0}
            .horizontalOffset=${this._config?.gauge_type == "half" && typeof this._config.secondary != "string" && this._config.secondary?.state_size == "big" ? 16 : 0}
            .label=${typeof this._config.secondary != "string" && this._config.secondary?.state_size == "big" ? this._config?.label : ""}
            .stateMargin=${this._stateMargin}
            .labelFontSize=${this._config.label_font_size}
            .showUnit=${this._config.show_unit ?? true}
            .showSeconds=${this._config.show_seconds}
            .decimals=${this._config.decimals}
          ></modern-circular-gauge-state>
          ` : nothing}
          ${this._renderSecondaryState()}
          ${this._renderTertiaryState()}
        </div>
        ${this._config.show_icon ?? true ? this._renderIcon(icon) : nothing}
      </div> 
    </ha-card>
    `;
  }

  private _renderWarning(headerText?: string, stateText?: string, stateObj?: HassEntity, icon?: string): TemplateResult {
    const iconCenter = stateText === undefined || stateText?.length == 0;
    return html`
      <ha-card
      class="${classMap({
        "flex-column-reverse": this._config?.header_position == "top",
        "action": this._hasCardAction() && stateObj !== undefined
      })}"
      @action=${ifDefined(stateObj ? this._handleAction : undefined)}
      .actionHandler=${actionHandler({
        hasHold: hasAction(this._config?.hold_action),
        hasDoubleClick: hasAction(this._config?.double_tap_action),
      })}
      tabindex=${ifDefined(
        !this._config?.tap_action || hasAction(this._config?.tap_action)
        ? "0"
        : undefined
      )}
      >
      <div class="header" style=${styleMap({ "--gauge-header-font-size": this._config?.header_font_size ? `${this._config.header_font_size}px` : undefined,
        "transform": this._config?.header_offset ? `translate(0, ${this._config.header_offset}px)` : undefined })}>
        <p class="name">
          ${headerText}
        </p>
      </div>
      <div class=${classMap({ "icon-center": iconCenter, "container": true, "half-gauge": this._config?.gauge_type == "half", "full-gauge": this._config?.gauge_type == "full" })}>
        <modern-circular-gauge-element 
          .gaugeType=${this._config?.gauge_type}
          .radius=${this._config?.gauge_radius ?? RADIUS}
          error
        ></modern-circular-gauge-element>
        <modern-circular-gauge-state
          .hass=${this.hass}
          .stateOverride=${stateText}
          .verticalOffset=${this._config?.gauge_type == "half" ? -10 : 0}
          .gaugeType=${this._config?.gauge_type}
        ></modern-circular-gauge-state>
        ${this._config?.gauge_type == "half" && !iconCenter ? nothing : html`
        <div class="icon-container">
          <modern-circular-gauge-icon
            class="warning-icon"
            .hass=${this.hass}
            .stateObj=${stateObj}
            .icon=${icon}
            .position=${iconCenter ? 3 : 2}
          ></modern-circular-gauge-icon>
        </div>
        `}
      </div>
      </ha-card>
      `;
  }

  private _renderIcon(iconOverride?: string): TemplateResult {
    // Don't know where to put the icon in half gauge, so for now just don't render it
    if (this._config?.gauge_type == "half") {
      return html``;
    }

    const iconEntity = this._config?.icon_entity;

    let entityId: string | undefined;
    let templatedState: string | undefined;
    let segments: SegmentsConfig[] | undefined;
    let gaugeForegroundStyle: GaugeElementConfig | undefined;

    if (!iconEntity || iconEntity === "primary") {
      entityId = this._config?.entity;
      templatedState = this._templateResults?.entity?.result;
      segments = (this._templateResults?.segments?.result as unknown) as SegmentsConfig[] ?? this._config?.segments;
      gaugeForegroundStyle = this._config?.gauge_foreground_style;
    } else if (
      typeof this._config?.secondary === "object" &&
      iconEntity === "secondary"
    ) {
      entityId = this._config.secondary.entity;
      templatedState = this._templateResults?.secondaryEntity?.result;
      segments = (this._templateResults?.secondarySegments?.result as unknown) as SegmentsConfig[] ?? this._config.secondary.segments;
      gaugeForegroundStyle = this._config.secondary.gauge_foreground_style;
    } else if (
      typeof this._config?.tertiary === "object" &&
      (iconEntity === "tertiary")
    ) {
      entityId = this._config.tertiary.entity;
      templatedState = this._templateResults?.tertiaryEntity?.result;
      segments = (this._templateResults?.tertiarySegments?.result as unknown) as SegmentsConfig[] ?? this._config.tertiary.segments;
      gaugeForegroundStyle = this._config.tertiary.gauge_foreground_style;
    }

    const stateObj = this.hass.states[entityId || ""];
    if (!stateObj && templatedState === undefined) {
      return html``;
    }

    const value = Number(templatedState ?? stateObj.state);
    const iconCenter = !(this._config?.show_state ?? false) && (this._config?.show_icon ?? true);
    const secondaryHasLabel = typeof this._config?.secondary != "string" && this._config?.secondary?.label;
    const iconPosition = iconCenter ? 3 : secondaryHasLabel && this._hasSecondary ? 0 : this._hasSecondary ? 1 : 2;

    return html`
    <div class="icon-container">
      <modern-circular-gauge-icon
        class=${classMap({ "adaptive": !!this._config?.adaptive_icon_color })}
        style=${styleMap({ "--gauge-color": gaugeForegroundStyle?.color && gaugeForegroundStyle.color != "adaptive" ? gaugeForegroundStyle.color : computeSegments(value, segments, this._config?.smooth_segments, this) })}
        .hass=${this.hass}
        .stateObj=${stateObj}
        .icon=${iconOverride}
        .position=${iconPosition}
        .iconVerticalPositionOverride=${this._config?.icon_vertical_position}
        .iconSizeOverride=${this._config?.icon_size}
      ></modern-circular-gauge-icon>
    </div>
    `;
  }

  private _calcStateMargin(): number {
    let gauges: any[] = [];

    if (typeof this._config?.secondary != "string") {
      if (this._config?.secondary?.show_gauge == "inner") {
        const gauge = { radius: this._config.secondary.gauge_radius ?? INNER_RADIUS, width: this._config.secondary.gauge_foreground_style?.width ?? 4 };
        gauges.push(gauge)
      }
    }

    if (typeof this._config?.tertiary != "string") {
      if (this._config?.tertiary?.show_gauge == "inner") {
        const gauge = { radius: this._config.tertiary.gauge_radius ?? TERTIARY_RADIUS, width: this._config.tertiary.gauge_foreground_style?.width ?? 4 };
        gauges.push(gauge)
      }
    }

    gauges.push({ radius: this._config?.gauge_radius ?? RADIUS, width: this._config?.gauge_foreground_style?.width ?? (gauges.length > 1 ? 4 : 6) });
    const gauge = gauges.reduce((r, e) => r.radius < e.radius ? r : e);

    return (gauge.radius - gauge.width) * 2;
  }

  private _renderTertiaryRing(): TemplateResult {
    const tertiaryObj = this._config?.tertiary as TertiaryEntity;
    const stateObj = this.hass.states[tertiaryObj.entity || ""];
    const templatedState = this._templateResults?.tertiaryEntity?.result;
    const secondaryInner = (this._config?.secondary as SecondaryEntity).show_gauge == "inner";

    if (!tertiaryObj) {
      return html``;
    }

    if (tertiaryObj.show_gauge == "inner") {
      if (!stateObj && templatedState === undefined) {
        return html`
        <modern-circular-gauge-element
          class="tertiary"
          .radius=${secondaryInner ? TERTIARY_RADIUS : INNER_RADIUS}
          .gaugeType=${this._config?.gauge_type}
        ></modern-circular-gauge-element>
        `;
      }

      const domain = computeStateDomain(stateObj);
      let secondsUntil: number | undefined;

      if (stateObj?.attributes.device_class === "timestamp" ||
        TIMESTAMP_STATE_DOMAINS.includes(domain)
      ) {
        secondsUntil = getTimestampRemainingSeconds(stateObj);
      }

      let timerDuration: number | undefined;

      if (domain === "timer") {
        timerDuration = durationToSeconds(stateObj.attributes?.duration ?? "00:00");
        secondsUntil = getTimerRemainingSeconds(stateObj);
      }

      const min = Number(this._templateResults?.tertiaryMin?.result ?? tertiaryObj.min) || DEFAULT_MIN;
      const max = Number(this._templateResults?.tertiaryMax?.result ?? tertiaryObj.max ?? timerDuration) || DEFAULT_MAX;
      const segments = (this._templateResults?.tertiarySegments as unknown) as SegmentsConfig[] ?? tertiaryObj.segments;
      const numberState = Number(templatedState ?? secondsUntil ?? stateObj.attributes[tertiaryObj.attribute!] ?? stateObj.state);

      return html`
      <modern-circular-gauge-element
        class="tertiary"
        .min=${min}
        .max=${max}
        .value=${numberState}
        .radius=${tertiaryObj.gauge_radius ?? (secondaryInner ? TERTIARY_RADIUS : INNER_RADIUS)}
        .gaugeType=${this._config?.gauge_type}
        .segments=${segments}
        .smoothSegments=${this._config?.smooth_segments}
        .foregroundStyle=${tertiaryObj?.gauge_foreground_style}
        .backgroundStyle=${tertiaryObj?.gauge_background_style}
        .needle=${tertiaryObj?.needle}
        .startFromZero=${tertiaryObj?.start_from_zero}
        .rotateGauge=${this._config?.rotate_gauge}
      ></modern-circular-gauge-element>
      `;
    } else {
      if (!stateObj && templatedState === undefined) {
        return html``;
      }

      const numberState = Number(templatedState ?? stateObj.attributes[tertiaryObj.attribute!] ?? stateObj.state);

      if (stateObj?.state === "unavailable" && templatedState) {
        return html``;
      }
  
      if (isNaN(numberState)) {
        return html``;
      }
  
      const min = Number(this._templateResults?.min?.result ?? this._config?.min) || DEFAULT_MIN; 
      const max = Number(this._templateResults?.max?.result ?? this._config?.max) || DEFAULT_MAX;
  
      return html`
      <modern-circular-gauge-element
        class="tertiary"
        .min=${min}
        .max=${max}
        .value=${numberState}
        .radius=${this._config?.gauge_radius ?? RADIUS}
        .gaugeType=${this._config?.gauge_type}
        .foregroundStyle=${tertiaryObj?.gauge_foreground_style}
        .backgroundStyle=${tertiaryObj?.gauge_background_style}
        .rotateGauge=${this._config?.rotate_gauge}
        .outter=${true}
      ></modern-circular-gauge-element>
      `;
    }
  }

  private _renderSecondaryGauge(): TemplateResult {
    const secondaryObj = this._config?.secondary as SecondaryEntity;
    const stateObj = this.hass.states[secondaryObj.entity || ""];
    const templatedState = this._templateResults?.secondaryEntity?.result;

    if (!secondaryObj) {
      return html``;
    }
    
    if (secondaryObj.show_gauge == "inner") {
      if (!stateObj && templatedState === undefined) {
        return html`
        <modern-circular-gauge-element
          class="secondary"
          .radius=${INNER_RADIUS}
          .gaugeType=${this._config?.gauge_type}
        ></modern-circular-gauge-element>
        `;
      }

      const domain = computeStateDomain(stateObj);
      let secondsUntil: number | undefined;

      if (stateObj?.attributes.device_class === "timestamp" ||
        TIMESTAMP_STATE_DOMAINS.includes(domain)
      ) {
        secondsUntil = getTimestampRemainingSeconds(stateObj);
      }

      let timerDuration: number | undefined;

      if (domain === "timer") {
        timerDuration = durationToSeconds(stateObj.attributes?.duration ?? "00:00");
        secondsUntil = getTimerRemainingSeconds(stateObj);
      }

      const min = Number(this._templateResults?.secondaryMin?.result ?? secondaryObj.min) || DEFAULT_MIN;
      const max = Number(this._templateResults?.secondaryMax?.result ?? secondaryObj.max ?? timerDuration) || DEFAULT_MAX;
      const segments = (this._templateResults?.secondarySegments as unknown) as SegmentsConfig[] ?? secondaryObj.segments;
      const numberState = Number(templatedState ?? secondsUntil ?? stateObj.attributes[secondaryObj.attribute!] ?? stateObj.state);

      return html`
      <modern-circular-gauge-element
        class="secondary"
        .min=${min}
        .max=${max}
        .value=${numberState}
        .radius=${secondaryObj.gauge_radius ?? INNER_RADIUS}
        .gaugeType=${this._config?.gauge_type}
        .segments=${segments}
        .smoothSegments=${this._config?.smooth_segments}
        .foregroundStyle=${secondaryObj?.gauge_foreground_style}
        .backgroundStyle=${secondaryObj?.gauge_background_style}
        .needle=${secondaryObj?.needle}
        .startFromZero=${secondaryObj.start_from_zero}
        .rotateGauge=${this._config?.rotate_gauge}
      ></modern-circular-gauge-element>
      `;
    } else {
      if (!stateObj && templatedState === undefined) {
        return html``;
      }

      const numberState = Number(templatedState ?? stateObj.attributes[secondaryObj.attribute!] ?? stateObj.state);

      if (stateObj?.state === "unavailable" && templatedState) {
        return html``;
      }
  
      if (isNaN(numberState)) {
        return html``;
      }
  
      const min = Number(this._templateResults?.min?.result ?? this._config?.min) || DEFAULT_MIN; 
      const max = Number(this._templateResults?.max?.result ?? this._config?.max) || DEFAULT_MAX;
  
      return html`
      <modern-circular-gauge-element
        class="secondary"
        .min=${min}
        .max=${max}
        .value=${numberState}
        .radius=${this._config?.gauge_radius ?? RADIUS}
        .gaugeType=${this._config?.gauge_type}
        .foregroundStyle=${secondaryObj?.gauge_foreground_style}
        .backgroundStyle=${secondaryObj?.gauge_background_style}
        .outter=${true}
        .rotateGauge=${this._config?.rotate_gauge}
      ></modern-circular-gauge-element>
      `;
    }
  }

  private _renderSecondaryState(): TemplateResult {
    const secondary = this._config?.secondary;
    if (!secondary) {
      return html``;
    }

    const iconCenter = !(this._config?.show_state ?? false) && (this._config?.show_icon ?? true) && this._config?.gauge_type != "half";

    if (typeof secondary === "string") {
      this._hasSecondary = true;
      return html`
      <modern-circular-gauge-state
        class=${classMap({ "preview": this._inCardPicker!, "secondary": true })}
        .hass=${this.hass}
        .stateOverride=${this._templateResults?.secondary?.result ?? secondary}
        .verticalOffset=${this._config?.gauge_type == "half" ? -1 : 17}
        .stateMargin=${this._stateMargin}
        .gaugeType=${this._config?.gauge_type}
        small
      ></modern-circular-gauge-state>
      `;
    }

    if (!(secondary.show_state ?? true)) {
      return html``;
    }

    const stateObj = this.hass.states[secondary.entity || ""];
    const templatedState = this._templateResults?.secondaryEntity?.result;

    if (!stateObj && templatedState === undefined) {
      return html``;
    }

    this._hasSecondary = true;

    const attributes = stateObj?.attributes ?? undefined;

    const unit = secondary.unit ?? attributes?.unit_of_measurement;

    const state = Number(templatedState ?? attributes[secondary.attribute!] ?? stateObj.state);
    const stateOverride = this._templateResults?.secondaryStateText?.result ?? (isTemplate(String(secondary.state_text)) ? "" : (secondary.state_text || undefined));
    const segments = (this._templateResults?.secondarySegments?.result as unknown) as SegmentsConfig[] ?? secondary.segments;
    const segmentsLabel = this._getSegmentLabel(state, segments);

    let secondaryColor;

    if (secondary.adaptive_state_color) {
      if (secondary.show_gauge == "outter") {
        secondaryColor = computeSegments(state, (this._templateResults?.segments?.result as unknown) as SegmentsConfig[] ?? this._config?.segments, this._config?.smooth_segments, this);
      } else {
        secondaryColor = computeSegments(state, segments, this._config?.smooth_segments, this);
      }

      if (secondary.gauge_foreground_style?.color && secondary.gauge_foreground_style?.color != "adaptive") {
        secondaryColor = secondary.gauge_foreground_style?.color;
      }
    }

    const halfStateBig = this._config?.gauge_type == "half" && secondary.state_size == "big";

    return html`
    <modern-circular-gauge-state
      @action=${this._handleSecondaryAction}
      .actionHandler=${actionHandler({
        hasHold: hasAction(secondary.hold_action),
        hasDoubleClick: hasAction(secondary.double_tap_action),
      })}
      class=${classMap({ "preview": this._inCardPicker!, "secondary": true })}
      style=${styleMap({ "--state-text-color-override": secondaryColor ?? (secondary.state_size == "big" ? "var(--secondary-text-color)" : undefined), "--state-font-size-override": secondary.state_font_size ? `${secondary.state_font_size}px` : (halfStateBig ? `15px` : undefined) })}
      .hass=${this.hass}
      .stateObj=${stateObj}
      .entityAttribute=${secondary.attribute}
      .stateOverride=${(segmentsLabel || stateOverride) ?? templatedState}
      .unit=${unit}
      .verticalOffset=${secondary.state_size == "big" ? (this._config?.gauge_type == "half" ? -14 : 14) : iconCenter ? 22 : this._config?.gauge_type == "half" ? -1 : 17}
      .horizontalOffset=${halfStateBig ? -16 : 0}
      .small=${secondary.state_size != "big"}
      .label=${this._config?.gauge_type == "half" && secondary.state_size != "big" ? "" : secondary.label}
      .gaugeType=${this._config?.gauge_type}
      .stateMargin=${this._stateMargin}
      .labelFontSize=${secondary.label_font_size}
      .showUnit=${secondary.show_unit ?? true}
      .showSeconds=${secondary.show_seconds}
      .decimals=${secondary.decimals}
    ></modern-circular-gauge-state>
    `;
  }

  private _renderTertiaryState(): TemplateResult {
    const tertiary = this._config?.tertiary;
    if (!tertiary) {
      return html``;
    }

    if (typeof tertiary === "string") {
      return html`
      <modern-circular-gauge-state
        class=${classMap({ "preview": this._inCardPicker!, "tertiary": true })}
        .hass=${this.hass}
        .stateOverride=${this._templateResults?.tertiary?.result ?? tertiary}
        .verticalOffset=${this._config?.gauge_type == "half" ? (!this._hasSecondary ? -28 :-31) : -19}
        .stateMargin=${this._stateMargin}
        .gaugeType=${this._config?.gauge_type}
        small
      ></modern-circular-gauge-state>
      `;
    }

    const bigState = typeof this._config?.secondary == "object" ? this._config?.secondary?.state_size == "big" : false;

    if (!(tertiary.show_state ?? true) || bigState) {
      return html``;
    }

    const stateObj = this.hass.states[tertiary.entity || ""];
    const templatedState = this._templateResults?.tertiaryEntity?.result;

    if (!stateObj && templatedState === undefined) {
      return html``;
    }

    const attributes = stateObj?.attributes ?? undefined;
    const unit = tertiary.unit ?? attributes?.unit_of_measurement;
    const state = Number(templatedState ?? attributes[tertiary.attribute!] ?? stateObj.state);
    const stateOverride = this._templateResults?.tertiaryStateText?.result ?? (isTemplate(String(tertiary.state_text)) ? "" : (tertiary.state_text || undefined));
    const segments = (this._templateResults?.tertiarySegments?.result as unknown) as SegmentsConfig[] ?? tertiary.segments;
    const segmentsLabel = this._getSegmentLabel(state, segments);

    const threeGauges = (typeof this._config?.secondary != "string" && this._config?.secondary?.show_gauge == "inner") && (typeof this._config?.tertiary != "string" && this._config?.tertiary?.show_gauge == "inner");

    let adaptiveColor;

    if (tertiary.adaptive_state_color) {
      if (tertiary.show_gauge == "outter") {
        adaptiveColor = computeSegments(state, (this._templateResults?.segments?.result as unknown) as SegmentsConfig[] ?? this._config?.segments, this._config?.smooth_segments, this);
      } else {
        adaptiveColor = computeSegments(state, segments, this._config?.smooth_segments, this);
      }

      if (tertiary.gauge_foreground_style?.color && tertiary.gauge_foreground_style?.color != "adaptive") {
        adaptiveColor = tertiary.gauge_foreground_style?.color;
      }
    }

    return html`
    <modern-circular-gauge-state
      @action=${this._handleTertiaryAction}
      .actionHandler=${actionHandler({
        hasHold: hasAction(tertiary.hold_action),
        hasDoubleClick: hasAction(tertiary.double_tap_action),
      })}
      class=${classMap({ "preview": this._inCardPicker!, "tertiary": true })}
      style=${styleMap({ "--state-text-color-override": adaptiveColor ?? undefined , "--state-font-size-override": tertiary.state_font_size ? `${tertiary.state_font_size}px` : (this._config?.gauge_type == "half" && threeGauges ? "6px" : undefined) })}
      .hass=${this.hass}
      .stateObj=${stateObj}
      .entityAttribute=${tertiary.attribute}
      .stateOverride=${(segmentsLabel || stateOverride) ?? templatedState}
      .unit=${unit}
      .verticalOffset=${this._config?.gauge_type == "half" ? (!this._hasSecondary ? -28 : (threeGauges ? -29 : -31)) : -19}
      .stateMargin=${this._stateMargin}
      .showUnit=${tertiary.show_unit ?? true}
      .label=${this._config?.gauge_type == "half" ? "" : tertiary.label}
      .gaugeType=${this._config?.gauge_type}
      .labelFontSize=${tertiary.label_font_size}
      .showSeconds=${tertiary.show_seconds}
      .decimals=${tertiary.decimals}
      small
    ></modern-circular-gauge-state>
    `;
  }

  private _getSegmentLabel(numberState: number, segments: SegmentsConfig[] | undefined): string {
    if (segments) {
      let sortedSegments = [...segments].sort((a, b) => Number(a.from) - Number(b.from));

      for (let i = sortedSegments.length - 1; i >= 0; i--) {
        let segment = sortedSegments[i];
        if (numberState >= Number(segment.from) || i === 0) {
          return segment.label || "";
        }
      }
    }
    return "";
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
      secondary: this._config?.secondary,
      tertiary: this._config?.tertiary
    };
    
    Object.entries(templates).forEach(([key, value]) => {
      if (typeof value == "string") {
        this._tryConnectKey(key, value);
      } else if (key == "segments") {
        const segmentsStringified = JSON.stringify(value);
        this._tryConnectKey(key, segmentsStringified);
      }
    });

    if (typeof this._config?.secondary != "string") {
      const secondary = this._config?.secondary;
      const secondaryTemplates = {
        secondaryMin: secondary?.min,
        secondaryMax: secondary?.max,
        secondaryEntity: secondary?.entity,
        secondaryStateText: secondary?.state_text,
        secondarySegments: secondary?.segments
      };

      Object.entries(secondaryTemplates).forEach(([key, value]) => {
        if (typeof value == "string") {
          this._tryConnectKey(key, value);
        } else if (key == "secondarySegments") {
          const segmentsStringified = JSON.stringify(value);
          this._tryConnectKey(key, segmentsStringified);
        }
      });
    }

    if (typeof this._config?.tertiary != "string") {
      const tertiary = this._config?.tertiary;
      const tertiaryTemplates = {
        tertiaryMin: tertiary?.min,
        tertiaryMax: tertiary?.max,
        tertiaryEntity: tertiary?.entity,
        tertiaryStateText: tertiary?.state_text,
        tertiarySegments: tertiary?.segments
      };

      Object.entries(tertiaryTemplates).forEach(([key, value]) => {
        if (typeof value == "string") {
          this._tryConnectKey(key, value);
        } else if (key == "tertiarySegments") {
          const segmentsStringified = JSON.stringify(value);
          this._tryConnectKey(key, segmentsStringified);
        }
      });
    }
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
      secondary: this._config?.secondary,
      tertiary: this._config?.tertiary
    };
    
    Object.entries(templates).forEach(([key, _]) => {
      this._tryDisconnectKey(key);
    });

    if (typeof this._config?.secondary != "string") {
      const secondary = this._config?.secondary;
      const secondaryTemplates = {
        secondaryMin: secondary?.min,
        secondaryMax: secondary?.max,
        secondaryEntity: secondary?.entity,
        secondaryStateText: secondary?.state_text,
        secondarySegments: secondary?.segments
      };

      Object.entries(secondaryTemplates).forEach(([key, _]) => {
        this._tryDisconnectKey(key);
      });
    }

    if (typeof this._config?.tertiary != "string") {
      const tertiary = this._config?.tertiary;
      const tertiaryTemplates = {
        tertiaryMin: tertiary?.min,
        tertiaryMax: tertiary?.max,
        tertiaryEntity: tertiary?.entity,
        tertiaryStateText: tertiary?.state_text,
        tertiarySegments: tertiary?.segments
      };

      Object.entries(tertiaryTemplates).forEach(([key, _]) => {
        this._tryDisconnectKey(key);
      });
    }
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

  private _handleAction(ev: ActionHandlerEvent) {
    ev.stopPropagation();
    const targetEntity = this._config?.entity;
    const config = {
      ...this._config,
      entity: isTemplate(targetEntity ?? "") ? "" : targetEntity
    };

    handleAction(this, this.hass!, config, ev.detail.action!);
  }

  private _handleSecondaryAction(ev: ActionHandlerEvent) {
    ev.stopPropagation();
    if (typeof this._config?.secondary != "string") {
      const entity = typeof this._config?.secondary != "string" ? this._config?.secondary?.entity : "";
      const config = {
        ...this._config?.secondary,
        entity: isTemplate(entity ?? "") ? "" : entity
      }
      
      handleAction(this, this.hass!, config, ev.detail.action!);
    }
  }

  private _handleTertiaryAction(ev: ActionHandlerEvent) {
    ev.stopPropagation();
    if (typeof this._config?.tertiary != "string") {
      const entity = typeof this._config?.tertiary != "string" ? this._config?.tertiary?.entity : "";
      const config = {
        ...this._config?.tertiary,
        entity: isTemplate(entity ?? "") ? "" : entity
      }
      
      handleAction(this, this.hass!, config, ev.detail.action!);
    }
  }

  public getGridOptions(): LovelaceGridOptions {
    return {
      columns: 6,
      rows: 4,
      min_rows: this._config?.gauge_type == "half" ? 2 : 3,
      min_columns: 4
    };
  }

  public getLayoutOptions(): LovelaceLayoutOptions {
    return {
      grid_columns: 2,
      grid_rows: 3,
      grid_min_rows: this._config?.gauge_type == "half" ? 2 : 3,
      grid_min_columns: 2
    };
  }

  public getCardSize(): Promise<number> | number {
    return 4;
  }

  static get styles() {
    return css`
    :host {
      --gauge-primary-color: var(--light-blue-color);
      --gauge-secondary-color: var(--orange-color);
      --gauge-tertiary-color: var(--light-green-color);

      --gauge-color: var(--gauge-primary-color);
      --gauge-stroke-width: 6px;
      --inner-gauge-stroke-width: 4px;
      --gauge-header-font-size: 14px;

      --half-gauge-padding: 16px 0px 24px;
      --full-gauge-padding: 20px 0px;
    }

    ha-card {
      width: 100%;
      height: 100%;
      display: flex;
      padding: 10px;
      flex-direction: column-reverse;
      align-items: center;
    }

    ha-card.action {
      cursor: pointer
    }

    .flex-column-reverse {
      flex-direction: column;
    }
    
    .header {
      position: absolute;
      width: 100%;
      display: flex;
      flex-direction: column;
      text-align: center;
      padding: 0 10px;
      box-sizing: border-box;
    }

    .flex-column-reverse .header {
      position: relative;
    }
    
    .gauge-state {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 2;
      padding: inherit;
    }

    modern-circular-gauge-state {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      right: 0;
      padding: inherit;
    }

    .half-gauge modern-circular-gauge-state.secondary,
    .half-gauge modern-circular-gauge-state.tertiary {
      --state-font-size-override: 8px;
    }

    .half-gauge modern-circular-gauge-state:not(.secondary):not(.tertiary) {
      --state-font-size-override: 20px;
    }

    .container {
      position: relative;
      container-type: inline-size;
      container-name: container;
      width: 100%;
      height: 100%;
      box-sizing: border-box;
    }

    .container.half-gauge {
      padding: var(--half-gauge-padding);
    }

    .container.full-gauge {
      padding: var(--full-gauge-padding);
    }

    .flex-column-reverse .container {
      margin-bottom: 0px;
    }

    .state-label {
      font-size: 0.49em;
      fill: var(--secondary-text-color);
    }

    modern-circular-gauge-icon {
      color: var(--primary-color);
    }

    .warning-icon {
      color: var(--state-unavailable-color);
    }

    .adaptive {
      color: var(--gauge-color);
    }

    .value.adaptive, .secondary.adaptive, .tertiary-state.adaptive {
      fill: var(--gauge-color);
    }

    .name {
      width: 100%;
      font-size: var(--gauge-header-font-size);
      margin: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;

      line-height: 20px;
      letter-spacing: .1px;
      color: var(--primary-text-color);
    }

    .unit {
      font-size: .33em;
      opacity: 0.6;
    }

    .gauge-container {
      height: 100%;
      width: 100%;
      display: block;
    }

    modern-circular-gauge-element.secondary, modern-circular-gauge-element.tertiary {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      right: 0;
    }

    .half-gauge modern-circular-gauge-element.secondary, .half-gauge modern-circular-gauge-element.tertiary {
      padding: var(--half-gauge-padding);
    }

    .full-gauge modern-circular-gauge-element.secondary, .full-gauge modern-circular-gauge-element.tertiary {
      padding: var(--full-gauge-padding);
    }

    .icon-container {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      right: 0;
      padding: inherit;
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

    .segment {
      fill: none;
      stroke-width: var(--gauge-stroke-width);
      filter: brightness(100%);
    }

    .segments {
      opacity: 0.35;
    }

    .needle {
      fill: none;
      stroke-linecap: round;
      stroke-width: var(--gauge-stroke-width);
      stroke: var(--gauge-color);
      transition: all 1s ease 0s;
    }

    .needle-border {
      fill: none;
      stroke-linecap: round;
      stroke-width: calc(var(--gauge-stroke-width) + 4px);
      stroke: var(--card-background-color);
      transition: all 1s ease 0s, stroke 0.3s ease-out;
    }

    .secondary {
      --gauge-color: var(--gauge-secondary-color);
    }

    .tertiary {
      --gauge-color: var(--gauge-tertiary-color);
    }

    .dual-gauge modern-circular-gauge-element {
      --gauge-stroke-width: 4px;
    }

    .dot {
      fill: none;
      stroke-linecap: round;
      stroke-width: calc(var(--gauge-stroke-width) / 2);
      stroke: var(--primary-text-color);
      transition: all 1s ease 0s;
    }

    .dot.border {
      stroke: var(--gauge-color);
      stroke-width: var(--gauge-stroke-width);
    }
    `;
  }
}
