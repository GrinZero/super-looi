import type {
  ChoiceControlPrimitive,
  CycleStageStepView,
  HomeAppliance,
  ResolvedApplianceCardView,
  TileSpan,
  ToggleControlPrimitive,
} from "./types.js";

function mapCycleStages(
  stages: string[],
  activeStageIndex: number,
): CycleStageStepView[] {
  return stages.map((label, idx) => {
    if (activeStageIndex < 0) {
      return { label, state: "upcoming" };
    }
    if (idx < activeStageIndex) {
      return { label, state: "completed" };
    }
    if (idx === activeStageIndex) {
      return { label, state: "current" };
    }
    return { label, state: "upcoming" };
  });
}

function dedupeRecipeAndStage(recipeLabel: string | undefined, stageLabel: string): string | undefined {
  if (!recipeLabel) return undefined;
  const recipe = recipeLabel.trim();
  const stage = stageLabel.trim();
  if (!recipe || recipe === stage || stage.includes(recipe) || recipe.includes(stage)) {
    return undefined;
  }
  return recipe;
}

function finalizeCardHeader(
  view: ResolvedApplianceCardView,
  appliance: HomeAppliance,
): ResolvedApplianceCardView {
  if (view.header.trailing.kind === "badge") {
    const badgeLabel = view.header.trailing.label.trim();
    if (!view.isExpanded) {
      // On 1x1 cards, fold the badge into subtitle so 1x1 titles are never squeezed horizontally
      if (!view.header.subtitle.includes(badgeLabel)) {
        view.header.subtitle = view.header.subtitle
          ? `${badgeLabel} · ${view.header.subtitle}`
          : badgeLabel;
      }
      view.header.trailing = { kind: "none" };
    } else {
      // On expanded cards, strip the badge token from subtitle so it is not repeated in both slots
      const tokens = view.header.subtitle
        .split(" · ")
        .map((t) => t.trim())
        .filter((t) => t.length > 0 && t !== badgeLabel && !(badgeLabel === "离线" && t === "设备离线"));
      view.header.subtitle = tokens.join(" · ") || appliance.sourceLabel;
    }
  }
  return view;
}

/**
 * Resolves a span-aware, single-slot-ownership presentation model for an appliance card.
 *
 * Design invariants enforced:
 * 1. Header trailing slot only renders a controllable power icon button or an exceptional
 *    offline/fault badge — never a redundant status pill ("待机", "1/3 开启", "在线") that
 *    duplicates the subtitle or squeezes 1x1 card titles.
 * 2. Any dynamic state or metric owned by an expanded card body (e.g. target temperature
 *    in the thermostat stepper, brightness percentage on the dimmer slider, countdown timer
 *    in the cycle body, or stream status inside the camera viewport) is omitted from
 *    `header.subtitle` when expanded, and folded back into `header.subtitle` when collapsed (`1x1`).
 * 3. Cycle task progress tracks only contain real working stages (never "待机" or "完成"),
 *    keep all segments unlit (`upcoming`) when idle (`activeStageIndex < 0`), and label each
 *    segment once with its own stage name.
 */
export function resolveApplianceCardView(
  appliance: HomeAppliance,
  span: TileSpan = appliance.span,
): ResolvedApplianceCardView {
  const isExpanded = span !== "1x1";
  const isLarge = span === "2x2";
  const isTall = span === "1x2" || span === "2x2";
  const isTallOnly = span === "1x2";
  const title = appliance.displayName ?? appliance.name;
  const power = appliance.capabilities.power;

  const trailing: ResolvedApplianceCardView["header"]["trailing"] =
    power && power.controllable
      ? {
          kind: "power",
          entityId: power.entityId,
          domain: power.domain,
          isOn: power.isOn,
          controllable: power.controllable,
        }
      : !appliance.online
        ? {
            kind: "badge",
            label: "离线",
            tone: "muted",
          }
        : appliance.capabilities.vacuum?.statusCode === "error" ||
            /故障|错误|异常/.test(appliance.statusBadge)
          ? {
              kind: "badge",
              label: appliance.statusBadge,
              tone: "warning",
            }
          : { kind: "none" };

  let subtitle = appliance.conciseSubtitle;
  const out: ResolvedApplianceCardView = {
    span,
    isExpanded,
    header: {
      title,
      subtitle,
      trailing,
    },
  };

  // 1. Multi-gang switch (channels are rendered in body at all spans)
  if (appliance.icon === "switch_gang" && appliance.capabilities.multiGang) {
    const channels = appliance.capabilities.multiGang.channels;
    const onCount = channels.filter((c) => c.isOn).length;
    out.header.subtitle = !appliance.online
      ? "离线"
      : onCount > 0
        ? `已开 ${onCount} 路`
        : "全部关闭";
    out.multiGangChannels = channels;
    return finalizeCardHeader(out, appliance);
  }

  // 2. Camera
  if (appliance.icon === "camera" && appliance.capabilities.visionStream) {
    const vs = appliance.capabilities.visionStream;
    const statusPillText = vs.statusText || appliance.statusBadge;
    if (!isExpanded) {
      out.header.subtitle = !appliance.online
        ? "设备离线"
        : appliance.isActive
          ? statusPillText
          : "镜头物理遮蔽中";
      return finalizeCardHeader(out, appliance);
    }

    out.header.subtitle = !appliance.online
      ? "设备离线"
      : appliance.isActive
        ? "监控守护中"
        : "镜头物理遮蔽中";

    const footnoteCandidate = vs.storageStatusText ?? vs.lastMotionText ?? "移动侦测看护中";
    const footnoteText =
      footnoteCandidate !== statusPillText && footnoteCandidate !== out.header.subtitle
        ? footnoteCandidate
        : "移动侦测看护中";
    const storageBadge =
      vs.storageUsedPercent !== undefined && !footnoteText.includes("GB")
        ? `SD ${vs.storageUsedPercent}%`
        : undefined;

    out.cameraBody = {
      statusPillText,
      ...(vs.resolutionBadge ? { resolutionBadge: vs.resolutionBadge } : {}),
      footnoteText,
      ...(storageBadge ? { storageBadge } : {}),
      featureToggles: isLarge ? vs.featureToggles.slice(0, 3) : [],
    };
    return finalizeCardHeader(out, appliance);
  }

  // 3. Cycle & Batch Task Appliances (Vacuum, Cooker, Microwave, Washer, Dishwasher)
  if (appliance.archetype === "cycle_appliance") {
    const vac = appliance.capabilities.vacuum;
    const cycle = appliance.capabilities.cycleTask;
    const actions = appliance.capabilities.actions ?? [];

    if (appliance.icon === "vacuum" && vac) {
      const parts: string[] = [vac.statusLabel];
      if (vac.batteryPercent !== undefined) {
        parts.push(`电量 ${vac.batteryPercent}%`);
      }
      if (vac.cleaningAreaSqm !== undefined && vac.cleaningAreaSqm > 0) {
        parts.push(
          appliance.isActive ? `已扫 ${vac.cleaningAreaSqm}㎡` : `上次 ${vac.cleaningAreaSqm}㎡`,
        );
      } else if (vac.chargingLabel && vac.chargingLabel !== vac.statusLabel) {
        parts.push(vac.chargingLabel);
      }
      out.header.subtitle = parts.join(" · ");

      if (isExpanded) {
        const visibleActions = actions.slice(0, isTallOnly ? 2 : 3);
        const visibleConsumables = isLarge ? vac.consumables.slice(0, 4) : [];
        const fallbackStages =
          visibleActions.length === 0 && visibleConsumables.length === 0 && cycle
            ? mapCycleStages(cycle.stages, cycle.activeStageIndex)
            : undefined;
        out.vacuumBody = {
          actions: visibleActions,
          consumables: visibleConsumables,
          ...(fallbackStages ? { fallbackStages } : {}),
        };
      }
      return finalizeCardHeader(out, appliance);
    }

    if (cycle) {
      const recipe = dedupeRecipeAndStage(cycle.recipeLabel, cycle.stageLabel);
      const hasCountdown = cycle.remainingMinutes !== undefined && cycle.remainingMinutes > 0;
      const hasKeepWarm =
        !hasCountdown && cycle.keepWarmMinutes !== undefined && cycle.keepWarmMinutes > 0;

      if (!isExpanded) {
        const parts: string[] = [];
        if (recipe) parts.push(recipe);
        parts.push(cycle.stageLabel);
        if (hasCountdown) {
          parts.push(`剩余 ${cycle.remainingMinutes}m`);
        } else if (hasKeepWarm) {
          parts.push(`已保温 ${cycle.keepWarmMinutes}m`);
        } else if (cycle.temperatureCelsius !== undefined) {
          parts.push(`${cycle.temperatureCelsius}°C`);
        }
        out.header.subtitle = parts.join(" · ");
        return finalizeCardHeader(out, appliance);
      }

      // Expanded: countdown or keep-warm duration belongs to cycleBody.primaryReadout
      const primaryReadout = hasCountdown
        ? {
            value: `${cycle.remainingMinutes} min`,
            caption:
              cycle.temperatureCelsius !== undefined
                ? `${cycle.temperatureCelsius}°C`
                : "剩余时长",
          }
        : hasKeepWarm
          ? {
              value: `${cycle.keepWarmMinutes} min`,
              caption:
                cycle.temperatureCelsius !== undefined
                  ? `${cycle.temperatureCelsius}°C`
                  : "已保温",
            }
          : undefined;

      const headerParts: string[] = [];
      if (recipe) headerParts.push(recipe);
      headerParts.push(cycle.stageLabel);
      if (!primaryReadout && cycle.temperatureCelsius !== undefined) {
        headerParts.push(`${cycle.temperatureCelsius}°C`);
      }
      out.header.subtitle = headerParts.join(" · ");

      out.cycleBody = {
        ...(primaryReadout ? { primaryReadout } : {}),
        stages: mapCycleStages(cycle.stages, cycle.activeStageIndex),
        actions: isLarge || isTallOnly ? actions.slice(0, isLarge ? 4 : 2) : [],
      };
      return finalizeCardHeader(out, appliance);
    }
  }

  // 4. Climate & Thermostat (AC, Fan, Purifier, Dehumidifier, Kettle, Blanket)
  if (appliance.archetype === "climate") {
    const therm = appliance.capabilities.thermostat;
    const modeBar = appliance.capabilities.modeBar;
    const controls = appliance.capabilities.controls ?? [];
    const fanCtrl = controls.find(
      (c): c is ChoiceControlPrimitive => c.kind === "choice" && c.id === "fan_level",
    );
    const swingToggle = controls.find(
      (c): c is ToggleControlPrimitive =>
        c.kind === "toggle" && /摇头|摆风|swing|oscillat/i.test(c.label),
    );

    if (!isExpanded) {
      return finalizeCardHeader(out, appliance);
    }

    if (therm) {
      const showModeBar = Boolean(modeBar) && (isLarge || isTall);
      const showFanLevel = Boolean(fanCtrl) && (isLarge || isTall);
      const showSwingToggle = Boolean(swingToggle) && isLarge;

      if (appliance.icon === "kettle") {
        const stateText = appliance.isActive ? "保温中" : "待机";
        const waterTempText =
          therm.currentTemp !== undefined ? `水温 ${therm.currentTemp}°C` : undefined;
        out.header.subtitle = [stateText, waterTempText].filter(Boolean).join(" · ");
      } else {
        const modeText = appliance.isActive
          ? showModeBar
            ? "运行中"
            : (modeBar?.currentLabel ?? "运行中")
          : "已关闭";
        const roomTempText =
          therm.currentTemp !== undefined ? `室温 ${therm.currentTemp}°C` : undefined;
        out.header.subtitle = [modeText, roomTempText].filter(Boolean).join(" · ");
      }

      out.climateBody = {
        thermostat: {
          entityId: therm.entityId,
          domain: therm.domain,
          targetTemp: therm.targetTemp,
          minTemp: therm.minTemp,
          maxTemp: therm.maxTemp,
          step: therm.step,
          unit: therm.unit || "°C",
          controllable: therm.controllable,
          readoutText: `${therm.targetTemp}${therm.unit || "°C"}`,
        },
        ...(modeBar ? { modeBar } : {}),
        ...(fanCtrl ? { fanControl: fanCtrl } : {}),
        ...(swingToggle ? { swingToggle } : {}),
        showModeBar,
        showFanLevel,
        showSwingToggle,
      };
      return finalizeCardHeader(out, appliance);
    }

    // Non-thermostat climate appliance (Fan, Purifier, Dehumidifier)
    const showFanLevel = Boolean(fanCtrl);
    const showModeBar =
      Boolean(modeBar) && (isLarge || isTall || !showFanLevel);
    const showSwingToggle = Boolean(swingToggle) && isLarge;

    if (appliance.icon === "fan") {
      if (appliance.isActive) {
        if (showModeBar && showFanLevel) {
          out.header.subtitle = "送风中";
        } else if (showFanLevel) {
          out.header.subtitle = modeBar?.currentLabel ?? "送风中";
        } else if (showModeBar) {
          out.header.subtitle = fanCtrl?.currentLabel ?? "送风中";
        }
      } else {
        out.header.subtitle = "已关闭";
      }
    } else if (appliance.icon === "purifier") {
      const pmMetric = appliance.capabilities.telemetry.find((m) => m.key === "pm25");
      const pmStr = pmMetric
        ? `PM2.5 ${pmMetric.value}${pmMetric.badge ? ` ${pmMetric.badge}` : ""}`
        : undefined;
      if (showModeBar) {
        out.header.subtitle = pmStr ?? (appliance.isActive ? "净化中" : "已关闭");
      }
    }

    out.climateBody = {
      ...(modeBar ? { modeBar } : {}),
      ...(fanCtrl ? { fanControl: fanCtrl } : {}),
      ...(swingToggle ? { swingToggle } : {}),
      showModeBar,
      showFanLevel,
      showSwingToggle,
    };
    return finalizeCardHeader(out, appliance);
  }

  // 5. Lighting & Power (Light, Desk Lamp)
  if (appliance.archetype === "lighting_power" && isExpanded && appliance.capabilities.dimmer) {
    const dimmer = appliance.capabilities.dimmer;
    const showColorTemp = (isLarge || isTall) && Boolean(dimmer.colorTempRange);
    if (!appliance.isActive) {
      out.header.subtitle = "已关闭";
    } else if (appliance.capabilities.modeBar?.currentLabel) {
      out.header.subtitle = `场景 · ${appliance.capabilities.modeBar.currentLabel}`;
    } else if (!showColorTemp && dimmer.colorTempKelvin !== undefined) {
      out.header.subtitle = `色温 ${dimmer.colorTempKelvin}K`;
    } else {
      out.header.subtitle = "照明开启";
    }

    out.lightBody = {
      brightnessPercent: dimmer.brightnessPercent ?? 80,
      controllable: dimmer.controllable,
      entityId: dimmer.entityId,
      colorTempPresets: showColorTemp ? [2700, 4000, 5000] : [],
      activeColorTempKelvin: dimmer.colorTempKelvin,
    };
    return finalizeCardHeader(out, appliance);
  }

  // 6. Media & Pet quick actions when expanded
  if (
    isExpanded &&
    (appliance.icon === "feeder" ||
      appliance.icon === "waterer" ||
      appliance.archetype === "media") &&
    (appliance.capabilities.actions?.length ?? 0) > 0
  ) {
    out.quickActions = (appliance.capabilities.actions ?? []).slice(0, 2);
  }

  return finalizeCardHeader(out, appliance);
}

/**
 * Extracts all visible text slots rendered by a card view for invariant verification.
 */
export function collectCardVisibleTexts(view: ResolvedApplianceCardView): string[] {
  const texts: string[] = [view.header.title];
  if (view.header.subtitle) {
    texts.push(view.header.subtitle);
  }
  if (view.header.trailing.kind === "badge") {
    texts.push(view.header.trailing.label);
  }
  if (view.cycleBody) {
    if (view.cycleBody.primaryReadout) {
      texts.push(view.cycleBody.primaryReadout.value);
      texts.push(view.cycleBody.primaryReadout.caption);
    }
    for (const st of view.cycleBody.stages) {
      texts.push(st.label);
    }
    for (const act of view.cycleBody.actions) {
      texts.push(act.label);
    }
  }
  if (view.vacuumBody) {
    for (const act of view.vacuumBody.actions) {
      texts.push(act.label);
    }
    for (const c of view.vacuumBody.consumables) {
      texts.push(`${c.label.replace("寿命", "")} ${c.percent}%`);
    }
    if (view.vacuumBody.fallbackStages) {
      for (const st of view.vacuumBody.fallbackStages) {
        texts.push(st.label);
      }
    }
  }
  if (view.climateBody) {
    if (view.climateBody.thermostat) {
      texts.push(view.climateBody.thermostat.readoutText);
    }
    if (view.climateBody.showModeBar && view.climateBody.modeBar) {
      for (const opt of view.climateBody.modeBar.options.slice(0, 4)) {
        texts.push(opt.label);
      }
    }
    if (view.climateBody.showFanLevel && view.climateBody.fanControl) {
      for (const opt of view.climateBody.fanControl.options.slice(0, 4)) {
        texts.push(opt.label);
      }
    }
    if (view.climateBody.showSwingToggle && view.climateBody.swingToggle) {
      texts.push(view.climateBody.swingToggle.label);
    }
  }
  if (view.cameraBody) {
    texts.push(view.cameraBody.statusPillText);
    if (view.cameraBody.resolutionBadge) texts.push(view.cameraBody.resolutionBadge);
    texts.push(view.cameraBody.footnoteText);
    if (view.cameraBody.storageBadge) texts.push(view.cameraBody.storageBadge);
    for (const tog of view.cameraBody.featureToggles) {
      texts.push(tog.label);
    }
  }
  if (view.lightBody) {
    texts.push(`${view.lightBody.brightnessPercent}%`);
    for (const k of view.lightBody.colorTempPresets) {
      texts.push(`${k}K`);
    }
  }
  if (view.multiGangChannels) {
    for (const ch of view.multiGangChannels) {
      texts.push(ch.label);
    }
  }
  if (view.quickActions) {
    for (const act of view.quickActions) {
      texts.push(act.label);
    }
  }
  return texts;
}
