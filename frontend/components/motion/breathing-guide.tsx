"use client";

import { useEffect, useState } from "react";
import { Pause, Play, Wind, X } from "lucide-react";

type BreathingPhase = "inhale" | "hold" | "exhale" | "rest";

interface BreathingGuideProps {
  onClose?: () => void;
  variant?: "floating" | "inline";
}

const PHASES: { phase: BreathingPhase; label: string; shortLabel: string; subtext: string; duration: number }[] = [
  { phase: "inhale", label: "Inhale slowly", shortLabel: "Inhale", subtext: "Breathe in gently through your nose.", duration: 4 },
  { phase: "hold", label: "Hold gently", shortLabel: "Hold", subtext: "Pause without straining.", duration: 4 },
  { phase: "exhale", label: "Exhale softly", shortLabel: "Exhale", subtext: "Release the breath through your mouth.", duration: 6 },
  { phase: "rest", label: "Be still", shortLabel: "Rest", subtext: "Let your shoulders relax before the next breath.", duration: 2 },
];

export function BreathingGuide({ onClose, variant = "inline" }: BreathingGuideProps) {
  const [phaseIndex, setPhaseIndex] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(PHASES[0].duration);
  const [isActive, setIsActive] = useState(true);
  const [cyclesCompleted, setCyclesCompleted] = useState(0);

  const currentPhase = PHASES[phaseIndex];

  useEffect(() => {
    if (!isActive) return;

    const timer = setInterval(() => {
      setSecondsLeft((previous) => {
        if (previous <= 1) {
          const nextIndex = (phaseIndex + 1) % PHASES.length;
          setPhaseIndex(nextIndex);
          if (nextIndex === 0) setCyclesCompleted((count) => count + 1);
          return PHASES[nextIndex].duration;
        }
        return previous - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [isActive, phaseIndex]);

  const scale = currentPhase.phase === "inhale" || currentPhase.phase === "hold"
    ? 1.22
    : currentPhase.phase === "exhale"
      ? 0.88
      : 0.96;

  return (
    <div
      className={`breathing-guide-card breathing-guide-${variant}`}
      role={variant === "inline" && onClose ? "dialog" : "region"}
      aria-modal={variant === "inline" && onClose ? true : undefined}
      aria-labelledby="breathing-guide-title"
    >
      <div className="breathing-guide-header">
        <div className="breathing-guide-title-row">
          <span className="breathing-leaf-icon" aria-hidden="true"><Wind size={19} /></span>
          <div>
            <h3 className="breathing-guide-heading" id="breathing-guide-title">Breathing guide</h3>
            <p className="breathing-guide-subheading">4–4–6–2 rhythm · Cycle {cyclesCompleted + 1}</p>
          </div>
        </div>
        <div className="breathing-controls">
          <button
            type="button"
            className="breathing-toggle-btn"
            onClick={() => setIsActive((active) => !active)}
            aria-label={isActive ? "Pause breathing exercise" : "Resume breathing exercise"}
          >
            {isActive ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
            {isActive ? "Pause" : "Resume"}
          </button>
          {onClose && (
            <button
              type="button"
              className="breathing-close-btn"
              onClick={onClose}
              aria-label="Close breathing guide"
              autoFocus={variant === "inline"}
            >
              <X size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <div className="breathing-circle-stage" aria-hidden="true">
        <div
          className={`breathing-circle-core phase-${currentPhase.phase}${isActive ? " is-active" : ""}`}
          style={{
            transform: `scale(${isActive ? scale : 1})`,
            transitionDuration: isActive ? `${currentPhase.duration}s` : "160ms",
          }}
        >
          <span className="breathing-countdown">{secondsLeft}</span>
          <span className="breathing-countdown-unit">seconds</span>
        </div>
      </div>

      <div className="breathing-prompt-box" aria-live="polite" aria-atomic="true">
        <p className="breathing-phase-instruction">{isActive ? currentPhase.label : "Paused"}</p>
        <p className="breathing-phase-detail">{isActive ? currentPhase.subtext : "Resume whenever you feel ready."}</p>
      </div>

      <ol className="breathing-step-indicators" aria-label="Breathing phases">
        {PHASES.map((phase, index) => (
          <li className={index === phaseIndex ? "is-active" : ""} key={phase.phase} aria-current={index === phaseIndex ? "step" : undefined}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{phase.shortLabel}</strong>
            <small>{phase.duration}s</small>
          </li>
        ))}
      </ol>
    </div>
  );
}
