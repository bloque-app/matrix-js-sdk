/*
Copyright 2015, 2016 OpenMarket Ltd
Copyright 2019 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

/**
 * This is an internal module. See {@link MatrixHttpApi} for the public class.
 * @module http-api
 */

import {parse as parseContentType} from "content-type";
import * as utils from "./utils";
import {logger} from './logger';
import type EventEmitter from "events";
import type {IncomingMessage} from "http";
import type {ReadStream} from "fs";
import type {Request, Response, CoreOptions, RequestAPI} from "request";

// we use our own implementation of setTimeout, so that if we get suspended in
// the middle of a /sync, we cancel the sync as soon as we awake, rather than
// waiting for the delay to elapse.
import * as callbacks from "./realtime-callbacks";
import {IDeferred} from "./utils";
import {UriOptions} from "request";

/*
TODO:
- CS: complete register function (doing stages)
- Identity server: linkEmail, authEmail, bindEmail, lookup3pid
*/

/**
 * A constant representing the URI path for release 0 of the Client-Server HTTP API.
 */
export const PREFIX_R0 = "/_matrix/client/r0";

/**
 * A constant representing the URI path for as-yet unspecified Client-Server HTTP APIs.
 */
export const PREFIX_UNSTABLE = "/_matrix/client/unstable";

/**
 * URI path for v1 of the the identity API
 * @deprecated Use v2.
 */
export const PREFIX_IDENTITY_V1 = "/_matrix/identity/api/v1";

/**
 * URI path for the v2 identity API
 */
export const PREFIX_IDENTITY_V2 = "/_matrix/identity/v2";

/**
 * URI path for the media repo API
 */
export const PREFIX_MEDIA_R0 = "/_matrix/media/r0";

export enum HTTPMethod {
    Get = "GET",
    Post = "POST",
    Put = "PUT",
    Delete = "DELETE",
}

interface IMatrixOpts extends CoreOptions, UriOptions {
    // eslint-disable-next-line camelcase
    _matrix_opts: IOpts;
}

interface IOpts {
    baseUrl: string;
    idBaseUrl?: string;
    request: RequestAPI<Request, IMatrixOpts, {}>;
    prefix: string;
    onlyData?: boolean;
    accessToken?: string;
    extraParams?: Record<string, string>;
    localTimeoutMs?: number;
    useAuthorizationHeader?: boolean;
}

interface IProgress {
    loaded: number;
    total: number;
}

interface IUploadOpts {
    name?: string;
    includeFilename?: boolean;
    type?: string;
    rawResponse?: boolean;
    onlyContentUri?: boolean;
    progressHandler?(progress: IProgress): void;
    // deprecated
    callback?(err?: Error, body?: UploadResponse): void;
}

interface IUpload extends IProgress {
    xhr: XMLHttpRequest;
    promise: Promise<UploadResponse>;
}

interface IUploadResponse {
    // eslint-disable-next-line camelcase
    content_uri: string;
}

type UploadResponse = IUploadResponse | IResponse<IUploadResponse>;

type BodyParser<S, T> = (rawBody: S) => T;

interface IRequestOpts {
    localTimeoutMs?: number;
    prefix?: string;
    headers?: Record<string, string>;
    json?: boolean;
    bodyParser?: BodyParser<any, any>;
    qsStringifyOptions?: any;
}

/**
 * Construct a MatrixHttpApi.
 * @constructor
 * @param {EventEmitter} eventEmitter The event emitter to use for emitting events
 * @param {Object} opts The options to use for this HTTP API.
 * @param {string} opts.baseUrl Required. The base client-server URL e.g.
 * 'http://localhost:8008'.
 * @param {Function} opts.request Required. The function to call for HTTP
 * requests. This function must look like function(opts, callback){ ... }.
 * @param {string} opts.prefix Required. The matrix client prefix to use, e.g.
 * '/_matrix/client/r0'. See PREFIX_R0 and PREFIX_UNSTABLE for constants.
 *
 * @param {boolean} opts.onlyData True to return only the 'data' component of the
 * response (e.g. the parsed HTTP body). If false, requests will return an
 * object with the properties <tt>code</tt>, <tt>headers</tt> and <tt>data</tt>.
 *
 * @param {string} opts.accessToken The access_token to send with requests. Can be
 * null to not send an access token.
 * @param {Object=} opts.extraParams Optional. Extra query parameters to send on
 * requests.
 * @param {Number=} opts.localTimeoutMs The default maximum amount of time to wait
 * before timing out the request. If not specified, there is no timeout.
 * @param {boolean} [opts.useAuthorizationHeader = false] Set to true to use
 * Authorization header instead of query param to send the access token to the server.
 */
export class MatrixHttpApi {
    private readonly useAuthorizationHeader: boolean;
    private uploads: IUpload[] = [];

    constructor(private eventEmitter: EventEmitter, private opts: IOpts) {
        utils.checkObjectHasKeys(opts, ["baseUrl", "request", "prefix"]);
        this.opts.onlyData = opts.onlyData || false;
        this.useAuthorizationHeader = Boolean(opts.useAuthorizationHeader);
    }

    /**
     * Sets the baase URL for the identity server
     * @param {string} url The new base url
     */
    public setIdBaseUrl(url: string) {
        this.opts.idBaseUrl = url;
    }

    /**
     * Get the content repository url with query parameters.
     * @return {Object} An object with a 'base', 'path' and 'params' for base URL,
     *          path and query parameters respectively.
     */
    public getContentUri() {
        const params = {
            access_token: this.opts.accessToken,
        };
        return {
            base: this.opts.baseUrl,
            path: "/_matrix/media/r0/upload",
            params: params,
        };
    }

    /**
     * Upload content to the Home Server
     *
     * @param {object} file The object to upload. On a browser, something that
     *   can be sent to XMLHttpRequest.send (typically a File).  Under node.js,
     *   a Buffer, String or ReadStream.
     *
     * @param {object} opts  options object
     *
     * @param {string=} opts.name   Name to give the file on the server. Defaults
     *   to <tt>file.name</tt>.
     *
     * @param {boolean=} opts.includeFilename if false will not send the filename,
     *   e.g for encrypted file uploads where filename leaks are undesirable.
     *   Defaults to true.
     *
     * @param {string=} opts.type   Content-type for the upload. Defaults to
     *   <tt>file.type</tt>, or <tt>applicaton/octet-stream</tt>.
     *
     * @param {boolean=} opts.rawResponse Return the raw body, rather than
     *   parsing the JSON. Defaults to false (except on node.js, where it
     *   defaults to true for backwards compatibility).
     *
     * @param {boolean=} opts.onlyContentUri Just return the content URI,
     *   rather than the whole body. Defaults to false (except on browsers,
     *   where it defaults to true for backwards compatibility). Ignored if
     *   opts.rawResponse is true.
     *
     * @param {Function=} opts.callback Deprecated. Optional. The callback to
     *    invoke on success/failure. See the promise return values for more
     *    information.
     *
     * @param {Function=} opts.progressHandler Optional. Called when a chunk of
     *    data has been uploaded, with an object containing the fields `loaded`
     *    (number of bytes transferred) and `total` (total size, if known).
     *
     * @return {Promise} Resolves to response object, as
     *    determined by this.opts.onlyData, opts.rawResponse, and
     *    opts.onlyContentUri.  Rejects with an error (usually a MatrixError).
     */
    public uploadContent(file: File | Blob | Buffer | ReadStream, opts: IUploadOpts = {}) {
        if (utils.isFunction(opts)) {
            // deprecated: opts used to be callback
            opts = {
                callback: opts as IUploadOpts["callback"],
            };
        }

        // default opts.includeFilename to true (ignoring falsey values)
        const includeFilename = opts.includeFilename !== false;

        // if the file doesn't have a mime type, use a default since
        // the HS errors if we don't supply one.
        const contentType = opts.type || (<File>file).type || 'application/octet-stream';
        const fileName = opts.name || (<File>file).name;

        // XXX: We used to recommend setting file.stream to the thing to upload on
        // Node.js. As of 2019-06-11, this is still in widespread use in various
        // clients, so we should preserve this for simple objects used in
        // Node.js. File API objects (via either the File or Blob interfaces) in
        // the browser now define a `stream` method, which leads to trouble
        // here, so we also check the type of `stream`.
        let body = file as File | Blob;
        if (body.stream && typeof body.stream !== "function") {
            logger.warn(
                "Using `file.stream` as the content to upload. Future " +
                "versions of the js-sdk will change this to expect `file` to " +
                "be the content directly.",
            );
            body = body.stream as unknown as File | Blob;
        }

        // backwards-compatibility hacks where we used to do different things
        // between browser and node.
        let rawResponse = opts.rawResponse;
        if (rawResponse === undefined) {
            if (global.XMLHttpRequest) {
                rawResponse = false;
            } else {
                logger.warn(
                    "Returning the raw JSON from uploadContent(). Future " +
                    "versions of the js-sdk will change this default, to " +
                    "return the parsed object. Set opts.rawResponse=false " +
                    "to change this behaviour now.",
                );
                rawResponse = true;
            }
        }

        let onlyContentUri = opts.onlyContentUri;
        if (!rawResponse && onlyContentUri === undefined) {
            if (global.XMLHttpRequest) {
                logger.warn(
                    "Returning only the content-uri from uploadContent(). " +
                    "Future versions of the js-sdk will change this " +
                    "default, to return the whole response object. Set " +
                    "opts.onlyContentUri=false to change this behaviour now.",
                );
                onlyContentUri = true;
            } else {
                onlyContentUri = false;
            }
        }

        // browser-request doesn't support File objects because it deep-copies
        // the options using JSON.parse(JSON.stringify(options)). Instead of
        // loading the whole file into memory as a string and letting
        // browser-request base64 encode and then decode it again, we just
        // use XMLHttpRequest directly.
        // (browser-request doesn't support progress either, which is also kind
        // of important here)

        const upload: Partial<IUpload> = { loaded: 0, total: 0 };
        let promise: Promise<UploadResponse>;

        // XMLHttpRequest doesn't parse JSON for us. request normally does, but
        // we're setting opts.json=false so that it doesn't JSON-encode the
        // request, which also means it doesn't JSON-decode the response. Either
        // way, we have to JSON-parse the response ourselves.
        let bodyParser: BodyParser<string, UploadResponse> = null;
        if (!rawResponse) {
            bodyParser = function(rawBody: string) {
                let body = JSON.parse(rawBody);
                if (onlyContentUri) {
                    body = body.content_uri;
                    if (body === undefined) {
                        throw Error('Bad response');
                    }
                }
                return body;
            };
        }

        if (global.XMLHttpRequest) {
            const defer = utils.defer<UploadResponse>() as any;
            const xhr = new global.XMLHttpRequest();
            upload.xhr = xhr;
            const cb = requestCallback<string, UploadResponse>(defer, opts.callback, this.opts.onlyData, bodyParser);

            const timeoutFn = function() {
                xhr.abort();
                cb(new Error('Timeout'));
            };

            // set an initial timeout of 30s; we'll advance it each time we get a progress notification
            let timeoutTimer = callbacks.setTimeout(timeoutFn, 30000);

            xhr.onreadystatechange = function() {
                switch (xhr.readyState) {
                    case global.XMLHttpRequest.DONE:
                        callbacks.clearTimeout(timeoutTimer);
                        try {
                            if (xhr.status === 0) {
                                throw new AbortError();
                            }
                            if (!xhr.responseText) {
                                throw new Error('No response body.');
                            }
                        } catch (err) {
                            err.http_status = xhr.status;
                            cb(err);
                            return;
                        }
                        cb(undefined, xhr, xhr.responseText);
                        break;
                }
            };
            xhr.upload.addEventListener("progress", function(ev) {
                callbacks.clearTimeout(timeoutTimer);
                upload.loaded = ev.loaded;
                upload.total = ev.total;
                timeoutTimer = callbacks.setTimeout(timeoutFn, 30000);
                if (opts.progressHandler) {
                    opts.progressHandler({
                        loaded: ev.loaded,
                        total: ev.total,
                    });
                }
            });
            let url = this.opts.baseUrl + "/_matrix/media/r0/upload";

            const queryArgs = [];

            if (includeFilename && fileName) {
                queryArgs.push("filename=" + encodeURIComponent(fileName));
            }

            if (!this.useAuthorizationHeader) {
                queryArgs.push("access_token="
                    + encodeURIComponent(this.opts.accessToken));
            }

            if (queryArgs.length > 0) {
                url += "?" + queryArgs.join("&");
            }

            xhr.open("POST", url);
            if (this.useAuthorizationHeader) {
                xhr.setRequestHeader("Authorization", "Bearer " + this.opts.accessToken);
            }
            xhr.setRequestHeader("Content-Type", contentType);
            xhr.send(body as Blob);
            promise = defer.promise;

            // dirty hack (as per _request) to allow the upload to be cancelled.
            promise["abort"] = xhr.abort.bind(xhr);
        } else {
            const queryParams = {};

            if (includeFilename && fileName) {
                queryParams["filename"] = fileName;
            }

            promise = this.authedRequest<IUploadResponse>(
                opts.callback, HTTPMethod.Post, "/upload", queryParams, body, {
                    prefix: "/_matrix/media/r0",
                    headers: {"Content-Type": contentType},
                    json: false,
                    bodyParser: bodyParser,
                },
            );
        }

        // remove the upload from the list on completion
        const promise0 = promise.finally(() => {
            for (let i = 0; i < this.uploads.length; ++i) {
                if (this.uploads[i] === upload) {
                    this.uploads.splice(i, 1);
                    return;
                }
            }
        });

        // copy our dirty abort() method to the new promise
        promise0["abort"] = promise["abort"];

        upload.promise = promise0;
        this.uploads.push(upload as IUpload);

        return promise0;
    }

    cancelUpload(promise: Promise<UploadResponse>) {
        if (promise["abort"]) {
            promise["abort"]();
            return true;
        }
        return false;
    }

    getCurrentUploads() {
        return this.uploads;
    }

    idServerRequest<T>(
        callback: (err?: Error, body?: T) => void,
        method: HTTPMethod,
        path: string,
        params: Record<string, string>,
        prefix: string,
        accessToken?: string,
    ): Promise<T> {
        if (!this.opts.idBaseUrl) {
            throw new Error("No Identity Server base URL set");
        }

        const fullUri = this.opts.idBaseUrl + prefix + path;

        if (callback !== undefined && !utils.isFunction(callback)) {
            throw Error(
                "Expected callback to be a function but got " + typeof callback,
            );
        }

        const opts: IMatrixOpts = {
            uri: fullUri,
            method: method,
            withCredentials: false,
            json: true, // we want a JSON response if we can
            _matrix_opts: this.opts,
            headers: {},
        };
        if (method === 'GET') {
            opts.qs = params;
        } else if (typeof params === "object") {
            opts.json = params;
        }
        if (accessToken) {
            opts.headers['Authorization'] = `Bearer ${accessToken}`;
        }

        const defer = utils.defer<T>();
        this.opts.request(opts, requestCallback<object, T>(defer, callback, this.opts.onlyData));
        return defer.promise;
    }

    /**
     * Perform an authorised request to the homeserver.
     * @param {Function} callback Optional. The callback to invoke on
     * success/failure. See the promise return values for more information.
     * @param {string} method The HTTP method e.g. "GET".
     * @param {string} path The HTTP path <b>after</b> the supplied prefix e.g.
     * "/createRoom".
     *
     * @param {Object=} queryParams A dict of query params (these will NOT be
     * urlencoded). If unspecified, there will be no query params.
     *
     * @param {Object} [data] The HTTP JSON body.
     *
     * @param {Object|Number=} opts additional options. If a number is specified,
     * this is treated as `opts.localTimeoutMs`.
     *
     * @param {Number=} opts.localTimeoutMs The maximum amount of time to wait before
     * timing out the request. If not specified, there is no timeout.
     *
     * @param {sting=} opts.prefix The full prefix to use e.g.
     * "/_matrix/client/v2_alpha". If not specified, uses this.opts.prefix.
     *
     * @param {Object=} opts.headers map of additional request headers
     *
     * @return {Promise} Resolves to <code>{data: {Object},
     * headers: {Object}, code: {Number}}</code>.
     * If <code>onlyData</code> is set, this will resolve to the <code>data</code>
     * object only.
     * @return {module:http-api.MatrixError} Rejects with an error if a problem
     * occurred. This includes network problems and Matrix-specific error JSON.
     */
    public authedRequest<T>(
        callback: UserDefinedCallback<T>,
        method: HTTPMethod,
        path: string,
        queryParams: Record<string, string> = {},
        data: any,
        opts: IRequestOpts | number = {},
    ): Promise<T> {
        let requestOpts = opts as IRequestOpts;
        if (isFinite(<number>opts)) {
            // opts used to be localTimeoutMs
            requestOpts = {
                localTimeoutMs: <number>opts,
            };
        }

        if (this.useAuthorizationHeader) {
            if (!requestOpts.headers) {
                requestOpts.headers = {};
            }
            if (!requestOpts.headers.Authorization) {
                requestOpts.headers.Authorization = "Bearer " + this.opts.accessToken;
            }
            if (queryParams.access_token) {
                delete queryParams.access_token;
            }
        } else {
            if (!queryParams.access_token) {
                queryParams.access_token = this.opts.accessToken;
            }
        }

        const requestPromise = this.request<T>(callback, method, path, queryParams, data, requestOpts);

        requestPromise.catch((err) => {
            if (err.errcode == 'M_UNKNOWN_TOKEN') {
                this.eventEmitter.emit("Session.logged_out", err);
            } else if (err.errcode == 'M_CONSENT_NOT_GIVEN') {
                this.eventEmitter.emit(
                    "no_consent",
                    err.message,
                    err.data.consent_uri,
                );
            }
        });

        // return the original promise, otherwise tests break due to it having to
        // go around the event loop one more time to process the result of the request
        return requestPromise;
    }

    /**
     * Perform a request to the homeserver without any credentials.
     * @param {Function} callback Optional. The callback to invoke on
     * success/failure. See the promise return values for more information.
     * @param {string} method The HTTP method e.g. "GET".
     * @param {string} path The HTTP path <b>after</b> the supplied prefix e.g.
     * "/createRoom".
     *
     * @param {Object=} queryParams A dict of query params (these will NOT be
     * urlencoded). If unspecified, there will be no query params.
     *
     * @param {Object} [data] The HTTP JSON body.
     *
     * @param {Object=} opts additional options
     *
     * @param {Number=} opts.localTimeoutMs The maximum amount of time to wait before
     * timing out the request. If not specified, there is no timeout.
     *
     * @param {sting=} opts.prefix The full prefix to use e.g.
     * "/_matrix/client/v2_alpha". If not specified, uses this.opts.prefix.
     *
     * @param {Object=} opts.headers map of additional request headers
     *
     * @return {Promise} Resolves to <code>{data: {Object},
     * headers: {Object}, code: {Number}}</code>.
     * If <code>onlyData</code> is set, this will resolve to the <code>data</code>
     * object only.
     * @return {module:http-api.MatrixError} Rejects with an error if a problem
     * occurred. This includes network problems and Matrix-specific error JSON.
     */
    public request<T>(
        callback: UserDefinedCallback<T>,
        method: HTTPMethod,
        path: string,
        queryParams: Record<string, string> = {},
        data: any,
        opts: IRequestOpts = {},
    ): Promise<T> {
        const prefix = opts.prefix !== undefined ? opts.prefix : this.opts.prefix;
        const fullUri = this.opts.baseUrl + prefix + path;

        return this.requestOtherUrl(callback, method, fullUri, queryParams, data, opts);
    }

    /**
     * Perform a request to an arbitrary URL.
     * @param {Function} callback Optional. The callback to invoke on
     * success/failure. See the promise return values for more information.
     * @param {string} method The HTTP method e.g. "GET".
     * @param {string} uri The HTTP URI
     *
     * @param {Object=} queryParams A dict of query params (these will NOT be
     * urlencoded). If unspecified, there will be no query params.
     *
     * @param {Object} [data] The HTTP JSON body.
     *
     * @param {Object=} opts additional options
     *
     * @param {Number=} opts.localTimeoutMs The maximum amount of time to wait before
     * timing out the request. If not specified, there is no timeout.
     *
     * @param {sting=} opts.prefix The full prefix to use e.g.
     * "/_matrix/client/v2_alpha". If not specified, uses this.opts.prefix.
     *
     * @param {Object=} opts.headers map of additional request headers
     *
     * @return {Promise} Resolves to <code>{data: {Object},
     * headers: {Object}, code: {Number}}</code>.
     * If <code>onlyData</code> is set, this will resolve to the <code>data</code>
     * object only.
     * @return {module:http-api.MatrixError} Rejects with an error if a problem
     * occurred. This includes network problems and Matrix-specific error JSON.
     */
    public requestOtherUrl<T>(
        callback: UserDefinedCallback<T>,
        method: HTTPMethod,
        uri: string,
        queryParams: Record<string, string> = {},
        data: any,
        opts: IRequestOpts | number = {},
    ): Promise<T> {
        let requestOpts = opts as IRequestOpts;
        if (isFinite(<number>opts)) {
            // opts used to be localTimeoutMs
            requestOpts = {
                localTimeoutMs: <number>opts,
            };
        }

        return this._request(callback, method, uri, queryParams, data, requestOpts);
    }

    /**
     * Form and return a homeserver request URL based on the given path
     * params and prefix.
     * @param {string} path The HTTP path <b>after</b> the supplied prefix e.g.
     * "/createRoom".
     * @param {Object} queryParams A dict of query params (these will NOT be
     * urlencoded).
     * @param {string} prefix The full prefix to use e.g.
     * "/_matrix/client/v2_alpha".
     * @return {string} URL
     */
    getUrl(path: string, queryParams: Record<string, string>, prefix: string): string {
        let queryString = "";
        if (queryParams) {
            queryString = "?" + utils.encodeParams(queryParams);
        }
        return this.opts.baseUrl + prefix + path + queryString;
    }

    /**
     * @private
     *
     * @param {function} callback
     * @param {string} method
     * @param {string} uri
     * @param {object} queryParams
     * @param {object|string} data
     * @param {object=} opts
     *
     * @param {boolean} [opts.json =true] Json-encode data before sending, and
     *   decode response on receipt. (We will still json-decode error
     *   responses, even if this is false.)
     *
     * @param {object=} opts.headers  extra request headers
     *
     * @param {number=} opts.localTimeoutMs client-side timeout for the
     *    request. Default timeout if falsy.
     *
     * @param {function=} opts.bodyParser function to parse the body of the
     *    response before passing it to the promise and callback.
     *
     * @return {Promise} a promise which resolves to either the
     * response object (if this.opts.onlyData is truthy), or the parsed
     * body. Rejects
     */
    private _request<T>(
        callback: UserDefinedCallback<T>,
        method: HTTPMethod,
        uri: string,
        queryParams: Record<string, string> = {},
        data: any,
        opts: IRequestOpts = {},
    ): Promise<T> {
        if (callback !== undefined && !utils.isFunction(callback)) {
            throw Error(
                "Expected callback to be a function but got " + typeof callback,
            );
        }

        if (this.opts.extraParams) {
            queryParams = {
                ...queryParams,
                ...this.opts.extraParams,
            };
        }

        const headers = utils.extend({}, opts.headers || {});
        const json = opts.json === undefined ? true : opts.json;
        let bodyParser = opts.bodyParser;

        // we handle the json encoding/decoding here, because request and
        // browser-request make a mess of it. Specifically, they attempt to
        // json-decode plain-text error responses, which in turn means that the
        // actual error gets swallowed by a SyntaxError.

        if (json) {
            if (data) {
                data = JSON.stringify(data);
                headers['content-type'] = 'application/json';
            }

            if (!headers['accept']) {
                headers['accept'] = 'application/json';
            }

            if (bodyParser === undefined) {
                bodyParser = function(rawBody: string) {
                    return JSON.parse(rawBody);
                };
            }
        }

        const defer = utils.defer<T>();

        let timeoutId;
        let timedOut = false;
        let req;
        const localTimeoutMs = opts.localTimeoutMs || this.opts.localTimeoutMs;

        const resetTimeout = () => {
            if (localTimeoutMs) {
                if (timeoutId) {
                    callbacks.clearTimeout(timeoutId);
                }
                timeoutId = callbacks.setTimeout(function() {
                    timedOut = true;
                    if (req && req.abort) {
                        req.abort();
                    }
                    defer.reject(new MatrixError({
                        error: "Locally timed out waiting for a response",
                        errcode: "ORG.MATRIX.JSSDK_TIMEOUT",
                        timeout: localTimeoutMs,
                    }));
                }, localTimeoutMs);
            }
        };
        resetTimeout();

        const reqPromise = defer.promise;

        try {
            req = this.opts.request(
                {
                    uri: uri,
                    method: method,
                    withCredentials: false,
                    qs: queryParams,
                    qsStringifyOptions: opts.qsStringifyOptions,
                    useQuerystring: true,
                    body: data,
                    json: false,
                    timeout: localTimeoutMs,
                    headers: headers || {},
                    _matrix_opts: this.opts,
                },
                (err: Error, response: Response, body: string) => {
                    if (localTimeoutMs) {
                        callbacks.clearTimeout(timeoutId);
                        if (timedOut) {
                            return; // already rejected promise
                        }
                    }

                    const handlerFn = requestCallback<string, T>(defer, callback, this.opts.onlyData, bodyParser);
                    handlerFn(err, response, body);
                },
            );
            if (req) {
                // This will only work in a browser, where opts.request is the
                // `browser-request` import. Currently `request` does not support progress
                // updates - see https://github.com/request/request/pull/2346.
                // `browser-request` returns an XHRHttpRequest which exposes `onprogress`
                if ('onprogress' in req) {
                    req.onprogress = (e) => {
                        // Prevent the timeout from rejecting the deferred promise if progress is
                        // seen with the request
                        resetTimeout();
                    };
                }

                // FIXME: This is EVIL, but I can't think of a better way to expose
                // abort() operations on underlying HTTP requests :(
                if (req.abort) reqPromise["abort"] = req.abort.bind(req);
            }
        } catch (ex) {
            defer.reject(ex);
            if (callback) {
                callback(ex);
            }
        }
        return reqPromise;
    }
}

interface IResponse<T> {
    code: number;
    headers: IncomingMessage["headers"];
    data: T;
}

type UserDefinedCallback<T> = (err?: Error, body?: IResponse<T> | T) => void;

type RequestCallback<T> = {
    (err: MatrixError | Error | string, response?: XMLHttpRequest, body?: T | string): void;
    (err: MatrixError | Error | string, response?: IncomingMessage, body?: T | object): void;
};

/*
 * Returns a callback that can be invoked by an HTTP request on completion,
 * that will either resolve or reject the given defer as well as invoke the
 * given userDefinedCallback (if any).
 *
 * HTTP errors are transformed into javascript errors and the deferred is rejected.
 *
 * If bodyParser is given, it is used to transform the body of the successful
 * responses before passing to the defer/callback.
 *
 * If onlyData is true, the defer/callback is invoked with the body of the
 * response, otherwise the result object (with `code` and `data` fields)
 *
 */
function requestCallback<S extends string | object, T>(
    defer: IDeferred<T | IResponse<T>>,
    userDefinedCallback: UserDefinedCallback<T> = () => {},
    onlyData: boolean,
    bodyParser?: BodyParser<S, T>,
): RequestCallback<S> {
    return function(
        err: MatrixError | Error | string,
        response?: XMLHttpRequest | IncomingMessage,
        body?: S,
    ) {
        const httpStatus = (<XMLHttpRequest>response).status || (<IncomingMessage>response).statusCode;

        if (err) {
            // the unit tests use matrix-mock-request, which throw the string "aborted" when aborting a request.
            // See https://github.com/matrix-org/matrix-mock-request/blob/3276d0263a561b5b8326b47bae720578a2c7473a/src/index.js#L48
            const aborted = (<Error>err).name === "AbortError" || err === "aborted";
            if (!aborted && !(err instanceof MatrixError)) {
                // browser-request just throws normal Error objects,
                // not `TypeError`s like fetch does. So just assume any
                // error is due to the connection.
                err = new ConnectionError("request failed", err);
            }
        }

        let data = body as unknown as T; // assume S === T, bodyParser will correct it if not
        if (!err) {
            try {
                if (httpStatus >= 400) {
                    err = parseErrorResponse(response, body as string);
                } else if (bodyParser) {
                    data = bodyParser(body);
                }
            } catch (e) {
                err = new Error(`Error parsing server response: ${e}`);
            }
        }

        if (err) {
            defer.reject(err);
            userDefinedCallback(err as Error);
        } else {
            const res = {
                code: httpStatus,

                // XXX: why do we bother with this? it doesn't work for
                // XMLHttpRequest, so clearly we don't use it.
                headers: (<IncomingMessage>response).headers,
                data,
            };
            defer.resolve(onlyData ? data : res);
            userDefinedCallback(null, onlyData ? data : res);
        }
    };
}

/**
 * Attempt to turn an HTTP error response into a Javascript Error.
 *
 * If it is a JSON response, we will parse it into a MatrixError. Otherwise
 * we return a generic Error.
 *
 * @param {XMLHttpRequest|http.IncomingMessage} response response object
 * @param {String} body raw body of the response
 * @returns {Error}
 */
function parseErrorResponse(response: XMLHttpRequest | IncomingMessage, body: string): Error {
    const httpStatus = (<XMLHttpRequest>response).status || (<IncomingMessage>response).statusCode;
    const contentType = getResponseContentType(response);

    let err: Error;
    if (contentType) {
        if (contentType.type === 'application/json') {
            const jsonBody = typeof(body) === 'object' ? body : JSON.parse(body);
            err = new MatrixError(jsonBody);
        } else if (contentType.type === 'text/plain') {
            err = new Error(`Server returned ${httpStatus} error: ${body}`);
        }
    }

    if (!err) {
        err = new Error(`Server returned ${httpStatus} error`);
    }
    err["httpStatus"] = httpStatus; // XXX
    return err;
}


interface IContentType {
    type: string;
    parameters: object;
}

/**
 * extract the Content-Type header from the response object, and
 * parse it to a `{type, parameters}` object.
 *
 * returns null if no content-type header could be found.
 *
 * @param {XMLHttpRequest|http.IncomingMessage} response response object
 * @returns {{type: String, parameters: Object}?} parsed content-type header, or null if not found
 */
function getResponseContentType(response: XMLHttpRequest | IncomingMessage): IContentType | null {
    let contentType;
    if ((<XMLHttpRequest>response).getResponseHeader) {
        // XMLHttpRequest provides getResponseHeader
        contentType = (<XMLHttpRequest>response).getResponseHeader("Content-Type");
    } else if ((<IncomingMessage>response).headers) {
        // request provides http.IncomingMessage which has a message.headers map
        contentType = (<IncomingMessage>response).headers['content-type'] || null;
    }

    if (!contentType) {
        return null;
    }

    try {
        return parseContentType(contentType);
    } catch (e) {
        throw new Error(`Error parsing Content-Type '${contentType}': ${e}`);
    }
}

/**
 * Construct a Matrix error. This is a JavaScript Error with additional
 * information specific to the standard Matrix error response.
 * @constructor
 * @param {Object} errorJson The Matrix error JSON returned from the homeserver.
 * @prop {string} errcode The Matrix 'errcode' value, e.g. "M_FORBIDDEN".
 * @prop {string} name Same as MatrixError.errcode but with a default unknown string.
 * @prop {string} message The Matrix 'error' value, e.g. "Missing token."
 * @prop {Object} data The raw Matrix error JSON used to construct this object.
 * @prop {integer} httpStatus The numeric HTTP status code given
 */
export class MatrixError extends Error {
    public errcode: number;
    public data: object;

    constructor(errorJson) {
        errorJson = errorJson || {};
        super(`MatrixError: ${errorJson.errcode}`);
        this.errcode = errorJson.errcode;
        this.name = errorJson.errcode || "Unknown error code";
        this.message = errorJson.error || "Unknown message";
        this.data = errorJson;
    }
}

/**
 * Construct a ConnectionError. This is a JavaScript Error indicating
 * that a request failed because of some error with the connection, either
 * CORS was not correctly configured on the server, the server didn't response,
 * the request timed out, or the internet connection on the client side went down.
 * @constructor
 */
export class ConnectionError extends Error {
    constructor(message, private readonly cause = undefined) {
        super(message + (cause ? `: ${cause.message}` : ""));
    }

    get name() {
        return "ConnectionError";
    }
}

export class AbortError extends Error {
    constructor() {
        super("Operation aborted");
    }

    get name() {
        return "AbortError";
    }
}

/**
 * Retries a network operation run in a callback.
 * @param  {number}   maxAttempts maximum attempts to try
 * @param  {Function} callback    callback that returns a promise of the network operation. If rejected with ConnectionError, it will be retried by calling the callback again.
 * @return {any} the result of the network operation
 * @throws {ConnectionError} If after maxAttempts the callback still throws ConnectionError
 */
export async function retryNetworkOperation<T>(maxAttempts: number, callback: () => Promise<T>): Promise<T> {
    let attempts = 0;
    let lastConnectionError = null;
    while (attempts < maxAttempts) {
        try {
            if (attempts > 0) {
                const timeout = 1000 * Math.pow(2, attempts);
                logger.log(`network operation failed ${attempts} times,` +
                    ` retrying in ${timeout}ms...`);
                await new Promise(r => setTimeout(r, timeout));
            }
            return await callback();
        } catch (err) {
            if (err instanceof ConnectionError) {
                attempts += 1;
                lastConnectionError = err;
            } else {
                throw err;
            }
        }
    }
    throw lastConnectionError;
}