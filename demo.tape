# demo.tape — the README's 30-second GIF (docs/demo.gif).
#
# Produced manually at release time with vhs (https://github.com/charmbracelet/vhs):
#
#   npm i -g showreceipts   # or: npm link, from a release checkout
#   vhs demo.tape
#
# The GIF is not committed between releases; the tape is the recipe.
# `showreceipts demo` renders bundled synthetic scenarios, so the recording
# needs no session data and leaks nothing — the receipts shown are the same
# frozen goldens as docs/samples/*.txt.

Output docs/demo.gif

Set FontSize 15
Set Width 1000
Set Height 660
Set Padding 16
Set TypingSpeed 55ms

Type "showreceipts demo"
Sleep 800ms
Enter
Sleep 7s

Type "clear"
Enter
Sleep 500ms

# The CLI surface via --help. (An `audit` beat is deliberately avoided here:
# recorded live it would show either real session data or nothing, depending
# on the machine; --help records the same everywhere.)
Type "showreceipts --help"
Sleep 800ms
Enter
Sleep 6s

Type "clear"
Enter
Sleep 500ms

Type "showreceipts demo --ascii --width 60"
Sleep 800ms
Enter
Sleep 8s
