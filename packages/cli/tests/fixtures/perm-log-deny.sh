#!/bin/sh
echo "hook-ran" >> ./hook.log
cat > /dev/null
echo '{"decision":"deny","reason":"policy engine says no"}'
