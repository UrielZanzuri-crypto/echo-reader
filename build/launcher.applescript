-- Echo Reader launcher.
--
-- This is compiled into "Echo Reader.app" by scripts/make-app.sh. It is an
-- AppleScript applet rather than a bare shell-script bundle because macOS only
-- grants Finder-launched apps access to protected folders (Desktop, Documents,
-- Downloads) through the privacy prompt, and it shows that prompt for applets
-- but silently denies plain script bundles. Everything real happens in
-- scripts/launcher.sh, which reports its own errors as alerts.
on run
	set appPath to POSIX path of (path to me)
	set projectDir to do shell script "dirname " & quoted form of appPath
	try
		do shell script quoted form of (projectDir & "/scripts/launcher.sh") & " " & quoted form of projectDir
	end try
end run
