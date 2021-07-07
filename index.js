const fs = require("fs");
const http = require('http');
const https = require('https');
const {consumer_key, redirect_uri} = require("./credentials/credentials.json");

const port = 3000;
const server = http.createServer();

server.on("listening", listen_handler);
server.listen(port);
function listen_handler(){
    console.log(`Now Listening on Port ${port}`);
}

server.on("request", request_handler);
function request_handler(req, res){
    console.log(`New Request from ${req.socket.remoteAddress} for ${req.url}`);
    if(req.url === '/'){
        const form = fs.createReadStream('html/index.html');
        res.writeHead(200,{"Content-Type": "text/html"})
        form.pipe(res);
    }
    else if(req.url.startsWith("/search")){
        const url = new URL(req.url, "https://localhost:3000");
        const term = url.searchParams.get("term")
        const token_cache_file = './credentials/token.json'
        let cache_valid = false;
        if(fs.existsSync(token_cache_file)){
            var cached_token_object = require(token_cache_file);
            if(new Date(cached_token_object.expiration) > Date.now()){
                console.log("CACHE EXISTS")
                cache_valid = true;
            }
        }
        get_joke(term, cache_valid, res);
    }

    else if(req.url.startsWith("/receive_code")){
        let {code, joke_url} = require("./credentials/auth.json")
        console.log("CODE TO REQUEST TOKEN", code);
        request_access_token(code, joke_url, res);
        
    }
    else if(req.url.startsWith("/getjoke")){
        let token_object = require('./credentials/token.json');
        let jokes_url = require("./credentials/url.json");
        const access_token = token_object.access_token;
        create_joke_list(jokes_url, access_token, res);
    }
    else{
        res.writeHead(404, {"Content-Type": "text/html"});
        res.end(`<h1>CONTENT NOT FOUND</h1>`)
    }
}

function get_joke(term, cache_valid, res){
    const joke_endpoint = `https://icanhazdadjoke.com/search?term=${term}`
    https.request(
        joke_endpoint, 
        {method:"GET", 
        headers:{Accept: "application/json"}}, 
        (jokes_stream) => process_joke_stream(jokes_stream, receive_results, cache_valid, res))
        .end();
}

function process_joke_stream(stream, callback, ...args){
    let jokes_data = "";
    stream.on("data", chunk => jokes_data +=chunk);
    stream.on("end", () => callback(jokes_data, ...args));
}

function receive_results(jokes_data, cache_valid, res){
    const joke_object = JSON.parse(jokes_data)
    if(joke_object.total_jokes == 0){
        not_found(res);
    }

    let jokes_url = []
    for(let i = 0; i < joke_object.results.length; i++){
        jokes_url.push(joke_object.results[i].id);
    }
    if(cache_valid === true){
        fs.writeFile(`./credentials/url.json`, JSON.stringify(jokes_url), () => console.log("URL SAVED"))
        res.writeHead(302, {Location: "http://localhost:3000/getjoke"}).end();
        
    }
    else{
        send_request_token(jokes_url, res);
    }
    
}
function send_request_token(joke_url, res){
    const token_endpoint = "https://getpocket.com/v3/oauth/request";
    const post_data = JSON.stringify({consumer_key, redirect_uri})
    let options = {
        method: "POST",
        headers: {
            "Content-Type":"application/json; charset=UTF-8",
            "X-Accept":"application/json",
        }
    }    
    https.request(
        token_endpoint,
        options,
        (token_stream) => process_stream(token_stream, receive_request_token, joke_url, res)
	).end(post_data)
}

function process_stream (stream, callback, ...args){
	let body = "";
	stream.on("data", chunk => body += chunk);
	stream.on("end", () => callback(body, ...args));
}

function receive_request_token(body, joke_url, res){
    const request_token = JSON.parse(body);
    redirect_to_pocket(request_token, joke_url, res);
}

function redirect_to_pocket(request_token, joke_url, res){
    const code = request_token.code;
    const authorize_endpoint = "https://getpocket.com/auth/authorize?"
    res.writeHead(302, {Location: `${authorize_endpoint}request_token=${code}&redirect_uri=${redirect_uri}`}).end();
    fs.writeFile('./credentials/auth.json', JSON.stringify({consumer_key, code, joke_url}), () => console.log("Auth File Written")); 
    fs.writeFile(`./credentials/url.json`, JSON.stringify(joke_url), () => console.log("URL SAVED"))
}

function request_access_token(code, joke_url, res){
    const authorize_endpoint = "https://getpocket.com/v3/oauth/authorize"
    const access_token = JSON.stringify({consumer_key, code})
    const token_request_time = new Date();
    const options = {
        method: "POST",
        headers: {
            "Content-Type":"application/json; charset=UTF8",
            "X-Accept":"application/json"
        }
    }
    https.request(
        authorize_endpoint,
        options,
        (token_stream) => process_stream(token_stream, receive_access_token, joke_url, token_request_time, res)
	).end(access_token);
}

function receive_access_token(body, joke_url, token_request_time, res){
    const access_token_body = JSON.parse(body);
    const access_token = access_token_body.access_token;
    console.log("REQUESTED TOKEN TIME:",token_request_time);
    access_token_body.expiration = new Date(token_request_time.getTime() + (3600000));
    console.log("ACCESS TOKEN EXPIRATION",access_token.expiration);
    fs.writeFile('./credentials/token.json', JSON.stringify(access_token_body), () => console.log("Access token cached"))
    create_joke_list(joke_url, access_token, res);
}

function create_joke_list(jokes_url, access_token, res){
    console.log("JOKE URL LENGTH", jokes_url);
    const token = access_token;
    console.log(token);
    const list_endpoint = "https://getpocket.com/v3/add";
    let options = {
        method: "POST",
        headers: {
            "Content-Type":"application/json; charset=UTF-8",
            "X-Accept":"application/json",
        }
    }
    let task_added_count = 0;
    jokes_url.forEach(url => create_task(url))
    function create_task(url){
        console.log("JOKE URL", url)
        const post_data = JSON.stringify({url:`https://icanhazdadjoke.com/j/${url}`, consumer_key, access_token:token})
        https.request(
            list_endpoint,
            options, 
            (task_stream) => process_stream(task_stream, received_response, res)
            ).end(post_data);
    }
    function received_response(body, res){
        console.log("CREATE TASK ",body)
        task_added_count++;
        if(task_added_count === jokes_url.length){
            res.writeHead(302, {Location: "https://getpocket.com/my-list"})
                .end();
        }
    }
}

function not_found(res){
    res.writeHead(404, {"Content-Type": "text/html"});
    res.end(`<h1>404 Not Found</h1>`);
}
