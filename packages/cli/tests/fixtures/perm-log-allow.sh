#!/bin/sh
echo "hook-ran" >> ./hook.log
cat > /dev/null
echo '{"decision":"allow"}'
