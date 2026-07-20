on sha256Text(theText)
	return do shell script "/usr/bin/printf %s " & quoted form of theText & " | /usr/bin/shasum -a 256 | /usr/bin/cut -d ' ' -f 1"
end sha256Text

on utcNow()
	return do shell script "/bin/date -u +%Y-%m-%dT%H:%M:%S.000Z"
end utcNow

on matchingProcessIds(executablePath)
	try
		return do shell script "/usr/bin/pgrep -f " & quoted form of executablePath
	on error
		return ""
	end try
end matchingProcessIds

on waitForOneProcess(executablePath)
	repeat with attempt from 1 to 120
		set ids to my matchingProcessIds(executablePath)
		if ids is not "" and ids does not contain linefeed then return ids
		delay 0.25
	end repeat
	error "C19 could not bind exactly one newly launched Microsoft PowerPoint process."
end waitForOneProcess

on waitForExit(executablePath)
	repeat with attempt from 1 to 180
		if my matchingProcessIds(executablePath) is "" then return true
		delay 0.25
	end repeat
	error "C19 owned Microsoft PowerPoint process did not exit naturally."
end waitForExit

on run argv
	if (count argv) is not 7 then error "C19 PowerPoint macOS worker requires seven arguments."
	set inputPath to item 1 of argv
	set outputPath to item 2 of argv
	set pdfPath to item 3 of argv
	set unusedWorkingPath to item 4 of argv
	set targetName to item 5 of argv
	set replacementText to item 6 of argv
	set expectedBeforeText to item 7 of argv
	set executablePath to "/Applications/Microsoft PowerPoint.app/Contents/MacOS/Microsoft PowerPoint"
	if my matchingProcessIds(executablePath) is not "" then error "C19 PowerPoint macOS suite requires PowerPoint to be fully closed; refusing to attach to a user session."
	set startedAt to my utcNow()
	set ownedProcessId to ""
	set beforeText to ""
	set afterText to ""
	set appVersion to ""
	set reopenedMatched to false
	set exportedMatched to false
	try
		tell application "Microsoft PowerPoint" to launch
		set ownedProcessId to my waitForOneProcess(executablePath)
		tell application "Microsoft PowerPoint"
			set appVersion to version as text
			set sourceDeck to open (POSIX file inputPath)
			set targetShape to shape targetName of slide 1 of sourceDeck
			set beforeText to content of text range of text frame of targetShape as text
			if beforeText is not expectedBeforeText then error "C19 named PowerPoint target text drifted before mutation."
			set content of text range of text frame of targetShape to replacementText
			save sourceDeck in (POSIX file outputPath) as save as Open XML presentation
			close sourceDeck saving no

			set reopenedDeck to open (POSIX file outputPath)
			set reopenedShape to shape targetName of slide 1 of reopenedDeck
			set afterText to content of text range of text frame of reopenedShape as text
			if afterText is not replacementText then error "C19 native sentinel text did not survive PowerPoint macOS save and reopen."
			set reopenedMatched to true
			save reopenedDeck in (POSIX file pdfPath) as save as PDF
			close reopenedDeck saving no

			set exportedDeck to open (POSIX file outputPath)
			set exportedShape to shape targetName of slide 1 of exportedDeck
			if (content of text range of text frame of exportedShape as text) is not replacementText then error "C19 exported PowerPoint macOS PPTX did not retain native sentinel text."
			set exportedMatched to true
			close exportedDeck saving no
			quit
		end tell
		my waitForExit(executablePath)
	on error errorMessage number errorNumber
		try
			tell application "Microsoft PowerPoint" to quit
		end try
		error errorMessage number errorNumber
	end try
	set endedAt to my utcNow()
	set outputText to "C19\tvalid\ttrue"
	set outputText to outputText & linefeed & "C19\tstartedAt\t" & startedAt
	set outputText to outputText & linefeed & "C19\tendedAt\t" & endedAt
	set outputText to outputText & linefeed & "C19\tversion\t" & appVersion
	set outputText to outputText & linefeed & "C19\tprocessId\t" & ownedProcessId
	set outputText to outputText & linefeed & "C19\tprocessOwned\ttrue"
	set outputText to outputText & linefeed & "C19\townedProcessExitedNaturally\ttrue"
	set outputText to outputText & linefeed & "C19\ttargetObjectId\t" & targetName
	set outputText to outputText & linefeed & "C19\tbeforeTextSha256\t" & my sha256Text(beforeText)
	set outputText to outputText & linefeed & "C19\tafterTextSha256\t" & my sha256Text(afterText)
	set outputText to outputText & linefeed & "C19\treopenedNativeTextMatched\t" & reopenedMatched
	set outputText to outputText & linefeed & "C19\texportedPptxReopenedNativeTextMatched\t" & exportedMatched
	return outputText
end run
