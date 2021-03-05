#!/bin/sh
echo "Make Read/Write"
chmod -R 777 ./dist
chmod -R 777 ./lib
echo "Build..."
yarn build:client 
yarn build:server
echo "Make Read Only"
chmod -R 555 ./dist
chmod -R 555 ./lib
