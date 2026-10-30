// A non-PTY SSH bootstrap may disappear while the QUIC connection remains useful.
// QUIC's finite idle timeout still bounds the helper lifetime.
#[cfg(unix)]
pub fn survive_bootstrap_disconnect() {
    // SAFETY: installing SIG_IGN is process-local and does not execute a handler.
    unsafe {
        libc::signal(libc::SIGHUP, libc::SIG_IGN);
    }
}

#[cfg(not(unix))]
pub fn survive_bootstrap_disconnect() {}
