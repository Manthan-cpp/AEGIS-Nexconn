"use client";

import { useEffect, useRef, useState } from "react";

import AuthControls from "./auth-controls";
import CompanionFlow from "./companion-flow";
import EmailAlertFlow from "./email-alert-flow";
import LegalFlow from "./legal-flow";
import HealthFlow from "./health-flow";
import ResponderFlow from "./responder-flow";
import SosFlow from "./sos-flow";
import TrustedCallerFlow from "./trusted-caller-flow";
import DirectMessagesFlow from "./direct-messages-flow";
import { BreathingGuide } from "../../components/motion/breathing-guide";
import {
  ArrowRight,
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  HeartPulse,
  Home,
  KeyRound,
  LockKeyhole,
  LogOut,
  Mail,
  Menu,
  MessageCircle,
  MessageSquareHeart,
  PhoneCall,
  Scale,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Wind,
  X,
} from "lucide-react";

type MainAppProps = {
  onPanicExit: () => void;
};

type ToolId = "home" | "sos" | "companion" | "legal" | "responder" | "caller" | "email" | "health" | "messages";
type NavGroup = "chatbots" | "sos" | null;

function ShieldMark() {
  return (
    <svg aria-hidden="true" className="aegis-mark" viewBox="0 0 40 44" fill="none">
      <path d="M20 2.5 35 8v10.8c0 10.1-6.1 18.8-15 22.7C11.1 37.6 5 28.9 5 18.8V8l15-5.5Z" fill="currentColor" opacity=".12" />
      <path d="M20 2.5 35 8v10.8c0 10.1-6.1 18.8-15 22.7C11.1 37.6 5 28.9 5 18.8V8l15-5.5Z" stroke="currentColor" strokeWidth="2.2" />
      <path d="m13.2 21.3 4.2 4.2 9.5-10" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.8" />
    </svg>
  );
}

const features: { id: Exclude<ToolId, "home">; title: string; description: string; icon: typeof Sparkles }[] = [
  { id: "companion", title: "Emotional support", description: "A steady conversation when you need someone to listen.", icon: Sparkles },
  { id: "legal", title: "Legal clarity", description: "India-scoped answers with official sources and sections.", icon: Scale },
  { id: "health", title: "Health guidance", description: "Private, direct answers without judgment or euphemisms.", icon: HeartPulse },
  { id: "sos", title: "Discreet SOS", description: "Hide a clear distress message inside an ordinary image.", icon: ShieldAlert },
  { id: "caller", title: "Trusted voice bridge", description: "Start a browser voice session with supportive relays.", icon: PhoneCall },
  { id: "email", title: "Email support", description: "Prepare a consented help request, even while offline.", icon: Mail },
  { id: "messages", title: "Private messages", description: "A quiet line between two signed-in Aegis accounts.", icon: MessageCircle },
  { id: "responder", title: "Responder workspace", description: "Decode an SOS image and review its urgency signal.", icon: KeyRound },
];

export default function MainApp({ onPanicExit }: MainAppProps) {
  const [activeTool, setActiveTool] = useState<ToolId>("home");
  const [emailSummary, setEmailSummary] = useState("");
  const [isNavOpen, setIsNavOpen] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState<NavGroup>(null);
  const [showBreathing, setShowBreathing] = useState(false);
  const navigationRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [activeTool]);

  useEffect(() => {
    document.body.classList.toggle("aegis-menu-open", isNavOpen);
    return () => document.body.classList.remove("aegis-menu-open");
  }, [isNavOpen]);

  useEffect(() => {
    if (!isNavOpen) return;

    const navigation = navigationRef.current;
    const menuButton = menuButtonRef.current;
    const frame = window.requestAnimationFrame(() => {
      navigation?.querySelector<HTMLButtonElement>("button")?.focus();
    });

    const keepFocusInside = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !navigation) return;
      const focusable = Array.from(navigation.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input:not(:disabled)"))
        .filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", keepFocusInside);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", keepFocusInside);
      menuButton?.focus();
    };
  }, [isNavOpen]);

  function goTo(tool: ToolId) {
    setEmailSummary("");
    setActiveTool(tool);
    setIsNavOpen(false);
    setExpandedGroup(null);
  }

  // A conversation can hand a prepared summary to Email support. This only
  // passes a string, so the email tool stays independent of messaging.
  function prepareEmailAlert(summary: string) {
    setEmailSummary(summary);
    setActiveTool("email");
    setIsNavOpen(false);
    setExpandedGroup(null);
  }

  function toggleGroup(group: Exclude<NavGroup, null>) {
    setExpandedGroup((current) => current === group ? null : group);
  }

  return (
    <main className="aegis-stage">
      <section className="aegis-app" data-active-tool={activeTool} aria-label="Aegis safety companion">
        <header className="aegis-header">
          <button className="aegis-brand" type="button" onClick={() => goTo("home")} aria-label="Go to Aegis home">
            <ShieldMark />
            <span>
              <span className="aegis-brand-name">Aegis</span>
              <span className="aegis-brand-note">Private safety space</span>
            </span>
          </button>

          <div className="aegis-header-actions">
            <button className="panic-button" type="button" onClick={onPanicExit}>
              <LogOut size={16} aria-hidden="true" />
              <span>Quick exit</span>
              <kbd>Esc</kbd>
            </button>
            <button
              ref={menuButtonRef}
              className="aegis-menu-button"
              type="button"
              onClick={() => setIsNavOpen(true)}
              aria-label="Open navigation"
              aria-expanded={isNavOpen}
              aria-controls="aegis-navigation"
            >
              <Menu size={20} aria-hidden="true" />
              <span>Menu</span>
            </button>
          </div>
        </header>

        {isNavOpen && <button className="aegis-nav-scrim" type="button" tabIndex={-1} onClick={() => setIsNavOpen(false)} aria-label="Close navigation" />}

        <nav
          ref={navigationRef}
          id="aegis-navigation"
          className={`aegis-nav${isNavOpen ? " is-open" : ""}`}
          aria-label="Aegis navigation"
          aria-hidden={!isNavOpen}
          inert={!isNavOpen}
        >
          <div className="aegis-nav-topline">
            <span>Navigate Aegis</span>
            <button className="aegis-nav-close" type="button" onClick={() => setIsNavOpen(false)} aria-label="Close navigation">
              <X size={18} aria-hidden="true" />
            </button>
          </div>

          <div className="aegis-nav-heading">
            <p className="eyebrow">Your space, your pace</p>
            <h2>What do you need right now?</h2>
            <p>Choose one next step. You can return here whenever you need to.</p>
          </div>

          <div className="aegis-nav-list">
            <button className={`aegis-nav-button${activeTool === "home" ? " is-active" : ""}`} type="button" onClick={() => goTo("home")} aria-current={activeTool === "home" ? "page" : undefined}>
              <span><Home size={17} aria-hidden="true" /> Home</span><ArrowUpRight size={16} aria-hidden="true" />
            </button>

            <div className={`aegis-nav-group${expandedGroup === "chatbots" ? " is-expanded" : ""}`}>
              <button className="aegis-nav-button" type="button" onClick={() => toggleGroup("chatbots")} aria-expanded={expandedGroup === "chatbots"} aria-controls="chatbot-submenu">
                <span><MessageSquareHeart size={17} aria-hidden="true" /> Chat support</span>
                {expandedGroup === "chatbots" ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
              </button>
              {expandedGroup === "chatbots" && (
                <div id="chatbot-submenu" className="aegis-nav-submenu">
                  <button className={`aegis-nav-subbutton${activeTool === "companion" ? " is-active" : ""}`} type="button" onClick={() => goTo("companion")} aria-current={activeTool === "companion" ? "page" : undefined}><Sparkles size={15} aria-hidden="true" /> Emotional support</button>
                  <button className={`aegis-nav-subbutton${activeTool === "legal" ? " is-active" : ""}`} type="button" onClick={() => goTo("legal")} aria-current={activeTool === "legal" ? "page" : undefined}><Scale size={15} aria-hidden="true" /> Legal support</button>
                  <button className={`aegis-nav-subbutton${activeTool === "health" ? " is-active" : ""}`} type="button" onClick={() => goTo("health")} aria-current={activeTool === "health" ? "page" : undefined}><HeartPulse size={15} aria-hidden="true" /> Health support</button>
                </div>
              )}
            </div>

            <div className={`aegis-nav-group${expandedGroup === "sos" ? " is-expanded" : ""}`}>
              <button className="aegis-nav-button is-sos" type="button" onClick={() => toggleGroup("sos")} aria-expanded={expandedGroup === "sos"} aria-controls="sos-submenu">
                <span><ShieldAlert size={17} aria-hidden="true" /> SOS tools</span>
                {expandedGroup === "sos" ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
              </button>
              {expandedGroup === "sos" && (
                <div id="sos-submenu" className="aegis-nav-submenu">
                  <button className={`aegis-nav-subbutton${activeTool === "sos" ? " is-active" : ""}`} type="button" onClick={() => goTo("sos")} aria-current={activeTool === "sos" ? "page" : undefined}><ShieldAlert size={15} aria-hidden="true" /> Prepare a discreet SOS</button>
                  <button className={`aegis-nav-subbutton${activeTool === "responder" ? " is-active" : ""}`} type="button" onClick={() => goTo("responder")} aria-current={activeTool === "responder" ? "page" : undefined}><KeyRound size={15} aria-hidden="true" /> Decode an SOS image</button>
                </div>
              )}
            </div>

            <button className={`aegis-nav-button${activeTool === "messages" ? " is-active" : ""}`} type="button" onClick={() => goTo("messages")} aria-current={activeTool === "messages" ? "page" : undefined}>
              <span><MessageCircle size={17} aria-hidden="true" /> Private messages</span><ArrowUpRight size={16} aria-hidden="true" />
            </button>
            <button className={`aegis-nav-button${activeTool === "caller" ? " is-active" : ""}`} type="button" onClick={() => goTo("caller")} aria-current={activeTool === "caller" ? "page" : undefined}>
              <span><PhoneCall size={17} aria-hidden="true" /> Trusted voice bridge</span><ArrowUpRight size={16} aria-hidden="true" />
            </button>
            <button className={`aegis-nav-button${activeTool === "email" ? " is-active" : ""}`} type="button" onClick={() => goTo("email")} aria-current={activeTool === "email" ? "page" : undefined}>
              <span><Mail size={17} aria-hidden="true" /> Email support</span><ArrowUpRight size={16} aria-hidden="true" />
            </button>
          </div>

          <div className="aegis-nav-footer">
            <AuthControls />
            <button className="panic-button aegis-nav-exit" type="button" onClick={onPanicExit}>
              <LogOut size={16} aria-hidden="true" /> Quick exit <kbd>Esc</kbd>
            </button>
          </div>
        </nav>

        <div className={`aegis-view-shell${activeTool === "home" ? " aegis-home-view" : ""}`} key={activeTool}>
          {activeTool === "sos" && <SosFlow onBack={() => goTo("home")} />}
          {activeTool === "companion" && <CompanionFlow onBack={() => goTo("home")} />}
          {activeTool === "email" && <EmailAlertFlow initialChatSummary={emailSummary} onBack={() => goTo("home")} />}
          {activeTool === "legal" && <LegalFlow onBack={() => goTo("home")} />}
          {activeTool === "health" && <HealthFlow onBack={() => goTo("home")} />}
          {activeTool === "responder" && <ResponderFlow onBack={() => goTo("home")} />}
          {activeTool === "caller" && <TrustedCallerFlow onBack={() => goTo("home")} />}
          {activeTool === "messages" && <DirectMessagesFlow onBack={() => goTo("home")} onPrepareAlert={prepareEmailAlert} />}

          {activeTool === "home" && (
            <>
              <section className="landing-hero" aria-labelledby="landing-title">
                <div className="landing-hero-copy">
                  <p className="eyebrow">A private place to begin</p>
                  <h2 className="aegis-hero-title" id="landing-title">When the world feels unsafe, you still deserve a quiet place.</h2>
                  <p className="landing-hero-lede">Clear information, calm conversation, and discreet ways to reach someone you trust—brought together in one private space.</p>
                  <div className="landing-hero-actions">
                    <button className="landing-primary-button" type="button" onClick={() => goTo("companion")}>
                      Start with support <ArrowRight size={16} aria-hidden="true" />
                    </button>
                    <button className="landing-secondary-button" type="button" onClick={() => setShowBreathing(true)}>
                      <Wind size={16} aria-hidden="true" /> Follow breathing guide
                    </button>
                  </div>
                  <p className="landing-privacy-note"><LockKeyhole size={15} aria-hidden="true" /> Nothing is shared without your choice.</p>
                </div>

                <aside className="landing-priority" aria-labelledby="priority-title">
                  <div className="landing-priority-icon" aria-hidden="true"><ShieldAlert size={22} /></div>
                  <p className="eyebrow">Discreet help</p>
                  <h3 id="priority-title">Need to reach someone without an obvious message?</h3>
                  <p>Turn a few words into a clear SOS, then hide it inside an ordinary-looking PNG image.</p>
                  <button className="landing-priority-action" type="button" onClick={() => goTo("sos")}>
                    Prepare a discreet SOS <ArrowUpRight size={17} aria-hidden="true" />
                  </button>
                  <div className="landing-priority-footer">
                    <ShieldCheck size={18} aria-hidden="true" />
                    <span><strong>You review everything first.</strong> The image is only shared when you choose to share it.</span>
                  </div>
                </aside>
              </section>

              <section className="landing-section landing-how" id="how-it-works" aria-labelledby="how-title">
                <div className="landing-section-intro">
                  <p className="eyebrow">How it works</p>
                  <h3 id="how-title">Support that meets you where you are.</h3>
                  <p>No complicated setup. Start with the one thing that feels most useful right now.</p>
                </div>
                <div className="landing-steps">
                  <div className="landing-step"><span className="landing-step-number">01</span><div><h4>Enter quietly</h4><p>Aegis appears as a familiar calculator until you choose to reveal your private space.</p></div></div>
                  <div className="landing-step"><span className="landing-step-number">02</span><div><h4>Find the right support</h4><p>Talk to a companion, understand your rights, ask a health question, or prepare an SOS.</p></div></div>
                  <div className="landing-step"><span className="landing-step-number">03</span><div><h4>Choose your next step</h4><p>Share only what feels safe through an image, email, voice bridge, or private message.</p></div></div>
                </div>
              </section>

              <section className="landing-section landing-features" aria-labelledby="features-title">
                <div className="landing-section-intro">
                  <p className="eyebrow">Your toolkit</p>
                  <h3 id="features-title">Built around real moments, not complicated menus.</h3>
                  <p>Each tool has one clear purpose, so choosing what to do next takes less effort.</p>
                </div>
                <div className="landing-feature-list">
                  {features.map(({ id, title, description, icon: Icon }) => (
                    <button className="landing-feature-row" type="button" onClick={() => goTo(id)} key={id}>
                      <span className="feature-icon-box" aria-hidden="true"><Icon size={19} /></span>
                      <span className="landing-feature-copy"><strong>{title}</strong><span>{description}</span></span>
                      <ArrowUpRight className="landing-feature-arrow" size={18} aria-hidden="true" />
                    </button>
                  ))}
                </div>
              </section>

              <section className="landing-closing" aria-label="Aegis closing message">
                <div>
                  <p className="eyebrow">Your pace. Your choice.</p>
                  <h3>You do not have to figure everything out at once.</h3>
                </div>
                <button className="landing-primary-button" type="button" onClick={() => goTo("companion")}>
                  Open your private space <ArrowRight size={16} aria-hidden="true" />
                </button>
              </section>
            </>
          )}
        </div>
      </section>

      {showBreathing && (
        <div className="aegis-breathing-modal-overlay" onClick={(event) => { if (event.target === event.currentTarget) setShowBreathing(false); }}>
          <BreathingGuide onClose={() => setShowBreathing(false)} variant="inline" />
        </div>
      )}
    </main>
  );
}
