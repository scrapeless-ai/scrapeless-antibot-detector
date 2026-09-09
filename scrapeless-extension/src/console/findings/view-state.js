class FindingsViewState {
  constructor(initialSession = 'empty') {
    this.state = initialSession;
  }

  assignSession(followingSession, localMeta = null) {
    if (this.state === followingSession) {
      return false;
    }
    this.state = followingSession;
    return true;
  }

  resolveSession() {
    return this.state;
  }
}

const FindingsViewModes = {
  EMPTY: 'empty',
  LOADING: 'loading',
  ANALYZING: 'analyzing',
  RESULTS: 'results',
  DISABLED: 'disabled'
};

if (typeof window !== 'undefined') {
  window.FindingsViewState = FindingsViewState;
  window.FindingsViewModes = FindingsViewModes;
} else if (typeof self !== 'undefined') {
  self.FindingsViewState = FindingsViewState;
  self.FindingsViewModes = FindingsViewModes;
}
