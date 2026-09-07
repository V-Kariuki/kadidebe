import { Link } from 'react-router-dom';

const FEATURES = [
  { title: 'Live parallel tally', body: 'Every polling stream reports in as events happen — materials dispatched, polling opened, counting started — so you see the real picture without waiting on official channels.' },
  { title: 'Full chain of custody', body: 'Ballot box serials, IEBC and agent seals, booklet serials, and seal-match checks at every handover are logged with a timestamp and the agent who recorded them.' },
  { title: 'Ballot-accounting built in', body: 'Results submissions reconcile ballots issued against ballots cast automatically, flagging anomalies rather than hiding them.' },
  { title: 'Jurisdiction-scoped access', body: 'Ward, constituency, county, and national coordinators each see exactly their own patch — nothing more, nothing hidden.' },
  { title: 'Incident reporting with evidence', body: 'Photo, video, or audio evidence attaches directly to incident reports, which can be escalated to a higher jurisdiction in one action.' },
  { title: 'Built for observers and aspirants', body: 'A view-only aspirant role gives candidates and their teams visibility into the numbers that matter to their race, without write access to the record.' }
];

export default function Landing() {
  return (
    <div className="landing">
      <header className="landing-nav">
        <div className="brand">
          <div className="brand-mark">
            <svg viewBox="0 0 34 30" fill="none" xmlns="http://www.w3.org/2000/svg">
              <polygon points="17,0 30,7.5 30,22.5 17,30 4,22.5 4,7.5" fill="#E8A33D" />
              <polygon points="17,5 25,9.5 25,20.5 17,25 9,20.5 9,9.5" fill="#1B140A" />
              <circle cx="17" cy="15" r="3.2" fill="#E8A33D" />
            </svg>
          </div>
          <div className="brand-text">Niko Kadi<br />Twende kwa Debe<span>Campaign HQ</span></div>
        </div>
        <Link to="/login" className="btn-sm primary">Sign In</Link>
      </header>

      <section className="landing-hero">
        <h1>A parallel view of election day, as it actually happens.</h1>
        <p>Track every polling stream from materials dispatch to results declared — ballot custody, live turnout, and incident reports, all in one place, scoped to your jurisdiction.</p>
        <div className="landing-cta">
          <Link to="/login" className="btn-sm primary landing-cta-primary">Sign In</Link>
          <Link to="/signup" className="btn-sm landing-cta-secondary">Request Access</Link>
        </div>
      </section>

      <section className="landing-features">
        {FEATURES.map((f) => (
          <div className="landing-feature-card" key={f.title}>
            <h2>{f.title}</h2>
            <p>{f.body}</p>
          </div>
        ))}
      </section>

      <footer className="landing-footer">
        <span>Niko Kadi Twende kwa Debe — Campaign HQ</span>
        <Link to="/login">Sign in to your account →</Link>
      </footer>
    </div>
  );
}
