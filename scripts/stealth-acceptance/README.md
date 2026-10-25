# Stealth audit acceptance

This rig is for issue 729's combined review branch. Its workflow runs only on the contributor fork, on disposable GitHub-hosted machines. The script refuses local and self-hosted execution. No personal Chrome profile, browser cookies or account credentials are supplied.

The headed job uses Chrome for Testing on Xvfb, a fresh profile and separate CLI/native-host directories for each mode. Chrome's internal sandbox remains enabled. The workflow permits user namespaces in the disposable Ubuntu VM so Chrome can create that sandbox. The tested binary and browser download are hashed in the evidence.

The first fixture matrix checks native double-click event order and application effect, covered/moved targets, successful contenteditable input, screenshot annotation DOM mutations, coordinate-hover globals, and background-tab focus through the real unpacked extension. CLI calls and fixture serving are asynchronous. Results and screenshots are retained as workflow artifacts even on failure.

This is acceptance work in progress. It does not yet cover real Lexical/ProseMirror/Monaco, the full frame matrix, hover transport interruption, every screenshot scale/scroll combination, or public detectors. The Windows control jobs compare an observed process-custody timeout against the audited base; they do not assume the timeout's cause.

The original full CI manual run exercises the existing headless E2E suite separately. Its legacy helpers often disable Chrome's internal sandbox, making the disposable runner the isolation boundary for that separate run.
