// How long since the last keyboard or mouse input anywhere in the Windows session.

#[cfg(windows)]
pub fn idle_ms() -> Option<u64> {
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    // SAFETY: info is a correctly sized LASTINPUTINFO that outlives the call.
    if unsafe { GetLastInputInfo(&mut info) } == 0 {
        return None;
    }
    // Both are 32-bit millisecond tick counts, so wrap like they do (every ~49.7 days).
    let now = unsafe { GetTickCount() };
    Some(now.wrapping_sub(info.dwTime) as u64)
}

#[cfg(not(windows))]
pub fn idle_ms() -> Option<u64> {
    None
}
