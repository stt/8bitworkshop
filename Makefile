
TSC=./node_modules/typescript/bin/tsc

all: src/cpu/z80fast.js

src/cpu/z80.js: src/cpu/z80.coffee
	coffee -c $<

src/cpu/z80fast.js: src/cpu/buildz80.js src/cpu/z80.js 
	node $< > $@

check:
	closure-compiler src/*.js src/cpu/*.js src/platform/*.js > /dev/null

lint:
	gjslint -r src

# https://github.com/Kentzo/git-archive-all
archive:
	mkdir -p release
	git-archive-all --prefix 8bitworkshop-2.0/ release/8bitworkshop-2.0.zip # 2.0
	#git-archive-all --prefix 8bitworkshop-1.1/ release/8bitworkshop-1.1.zip 1.1
	git archive --prefix 8bitworkshop- -o release/8bitworkshop-tools.zip HEAD tools


web:
	ifconfig | grep inet
	python2 -m SimpleHTTPServer 2>> http.out

tsweb:
	ifconfig | grep inet
	$(TSC) -w &
	python2 -m SimpleHTTPServer 2>> http.out
	#node ../nodejs-typescript-webserver/bin/FileServer.js .
