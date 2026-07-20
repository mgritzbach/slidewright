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
	error "C19 could not bind exactly one newly launched Keynote process."
end waitForOneProcess

on waitForExit(executablePath)
	repeat with attempt from 1 to 180
		if my matchingProcessIds(executablePath) is "" then return true
		delay 0.25
	end repeat
	error "C19 owned Keynote process did not exit naturally."
end waitForExit

using terms from application "Keynote"
	on findNativeTextItem(theSlide, targetName, expectedText)
		tell application "Keynote"
			repeat with itemRef in every text item of theSlide
				try
					if (name of itemRef as text) is targetName and (object text of itemRef as text) is expectedText then return itemRef
				end try
			end repeat
			repeat with itemRef in every text item of theSlide
				try
					if (object text of itemRef as text) is expectedText then return itemRef
				end try
			end repeat
		end tell
		error "C19 could not resolve the native Keynote text item by prepared object name or exact source text."
	end findNativeTextItem
end using terms from

on run argv
	if (count argv) is not 7 then error "C19 Keynote macOS worker requires seven arguments."
	set inputPath to item 1 of argv
	set outputPath to item 2 of argv
	set pdfPath to item 3 of argv
	set workingPath to item 4 of argv
	set targetName to item 5 of argv
	set replacementText to item 6 of argv
	set expectedBeforeText to item 7 of argv
	set executablePath to "/Applications/Keynote.app/Contents/MacOS/Keynote"
	if my matchingProcessIds(executablePath) is not "" then error "C19 Keynote macOS suite requires Keynote to be fully closed; refusing to attach to a user session."
	set startedAt to my utcNow()
	set ownedProcessId to ""
	set beforeText to ""
	set afterText to ""
	set appVersion to ""
	set reopenedMatched to false
	set exportedMatched to false
	try
		tell application "Keynote" to launch
		set ownedProcessId to my waitForOneProcess(executablePath)
		tell application "Keynote"
			set appVersion to version as text
			set sourceDocument to open (POSIX file inputPath)
			set targetItem to my findNativeTextItem(slide 1 of sourceDocument, targetName, expectedBeforeText)
			set beforeText to object text of targetItem as text
			set object text of targetItem to replacementText
			save sourceDocument in (POSIX file workingPath)
			close sourceDocument saving no

			set reopenedDocument to open (POSIX file workingPath)
			set reopenedItem to my findNativeTextItem(slide 1 of reopenedDocument, targetName, replacementText)
			set afterText to object text of reopenedItem as text
			if afterText is not replacementText then error "C19 native sentinel text did not survive Keynote save and reopen."
			set reopenedMatched to true
			export reopenedDocument to (POSIX file outputPath) as Microsoft PowerPoint
			close reopenedDocument saving no

			set exportedDocument to open (POSIX file outputPath)
			set exportedItem to my findNativeTextItem(slide 1 of exportedDocument, targetName, replacementText)
			if (object text of exportedItem as text) is not replacementText then error "C19 Keynote-exported PPTX did not retain native sentinel text."
			set exportedMatched to true
			export exportedDocument to (POSIX file pdfPath) as PDF
			close exportedDocument saving no
			quit
		end tell
		my waitForExit(executablePath)
	on error errorMessage number errorNumber
		try
			tell application "Keynote" to quit
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
