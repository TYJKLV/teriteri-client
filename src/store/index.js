import { createStore } from 'vuex'
import axios from 'axios';
import { ElMessage } from 'element-plus';
import { get } from '@/network/request'

/************** IM 长连接（/im）的连接管理 **************
 * 核心原则：websocket 断开只是"传输层"事件，**不代表登录失效**。
 * 登录态只由 ①登录/退出登录 ②HTTP 接口返回未登录 来决定。
 * 早期版本一断线就清空 isLogin 和 user，导致后端 token 还有效、页面却显示"未登录"，
 * 刷新后才凭缓存恢复——这就是"前后端登录态分裂"的根源。
 ****************************************************************/

// 当前 socket 实例（state.ws 只在连接真正 open 后才赋值，这里包含"连接中"的实例）
let imSocket = null;
// 待执行的重连定时器，避免重复排队
let imReconnectTimer = null;
// 已连续重连次数，用于指数退避
let imReconnectCount = 0;
// 重连间隔上限（毫秒）
const IM_RECONNECT_MAX_DELAY = 30000;

// 连接建立后必须先发送的鉴权指令帧，后端据此把 uid 绑定到该连接上
function buildAuthCommand() {
    return JSON.stringify({
        code: 100,
        content: "Bearer " + localStorage.getItem("teri_token"),
    });
}

// 主动关闭连接：打上标记，其 close 事件不会再触发自动重连
function closeSocketSilently(ws) {
    if (!ws) return;
    ws.imManualClose = true;
    try {
        ws.close();
    } catch (e) {
        // 连接可能还没建立完成，忽略关闭异常
    }
}

// 取消待执行的重连
function stopReconnect() {
    if (imReconnectTimer) {
        clearTimeout(imReconnectTimer);
        imReconnectTimer = null;
    }
}

// 复位所有"与登录强相关"的数据（退出登录 / 登录确实失效时才会用到）
function resetLoginState(state) {
    state.isLogin = false;
    state.user = {};
    state.msgUnread = [0, 0, 0, 0, 0, 0];
    state.attitudeToVideo = {};
    state.favorites = [];
    state.likeComment = [];
    state.dislikeComment = [];
}

export default createStore({
    state: {
        // 是否加载中
        isLoading: false,
        // 是否登录
        isLogin: false,
        // 是否外部触发打开登录框
        openLogin: false,
        // 当前用户
        user: {},
        // 分区列表
        channels: [],
        // 轮播图列表
        carousels: [],
        // 弹幕列表
        danmuList: [],
        // 未读消息数 分别对应"reply"/"at"/"love"/"system"/"whisper"/"dynamic"
        msgUnread: [0, 0, 0, 0, 0, 0],
        // 聊天列表
        chatList: [],
        // 当前聊天对象的uid (不是聊天的id)
        chatId: -1,
        // 当前页面是否在聊天界面
        isChatPage: false,
        // 实时通讯的socket
        ws: null,
        // 用户与当前播放视频的互动数据 {love, unlove, coin, collect}
        attitudeToVideo: {},
        // 用户点赞的评论 id
        likeComment: [],
        // 用户点踩的评论 id
        dislikeComment: [],
        // 登录用户的收藏夹列表
        favorites: [],
        // 访问用户的收藏夹列表
        userFavList: [],
        // 热搜列表
        trendings: [],
        // 搜索到的相关数据数量 [视频, 用户]
        matchingCount: [0, 0],
    },
    mutations: {
        // 退出登录或登录过期时初始化个别数据
        initData(state) {
            resetLoginState(state);
        },
        // 更新登录状态
        updateIsLogin(state, isLogin) {
            state.isLogin = isLogin;
        },
        // 更新当前用户
        updateUser(state, user) {
            state.user = user;
            // console.log("更新vuex中用户信息: ", state.user);
        },
        // 更新分区列表
        updateChannels(state, channels) {
            state.channels = channels;
            // console.log("vuex中的分区: ", state.channels);
        },
        // 更新轮播图列表
        updateCarousels(state, carousels) {
            state.carousels = carousels;
            // console.log("vuex中的轮播图: ", state.carousels);
        },
        // 更新弹幕列表
        updateDanmuList(state, danmuList) {
            state.danmuList = danmuList;
            // console.log("vuex中的弹幕列表: ", state.danmuList);
        },
        // 追加更新聊天列表
        updateChatList(state, chatList) {
            state.chatList.push(...chatList);
            // console.log("vuex中的聊天列表: ", state.chatList);
        },
        // 更新视频互动数据
        updateAttitudeToVideo(state, atv) {
            state.attitudeToVideo = atv;
            // console.log("vuex中的视频互动数据: ", state.attitudeToVideo);
        },
        // 更新用户点赞评论id列表
        updateLikeComment(state, lc) {
            state.likeComment = lc;
        },
        // 更新用户点踩评论id列表
        updateDislikeComment(state, dlc) {
            state.dislikeComment = dlc;
        },
        updateFavorites(state, favorites) {
            state.favorites = favorites;
            // console.log("vuex中的收藏夹列表: ", state.favorites);
        },

        updateTrendings(state, trendings) {
            state.trendings = trendings;
            // console.log("vuex中的热搜列表: ", state.trendings);
        },

        updateMatchingCount(state, matchingCount) {
            state.matchingCount = matchingCount;
        },

        // 处理websocket事件
        setWebSocket(state, ws) {
            state.ws = ws;
        },
        handleWsOpen() {
            // console.log("实时通信websocket已建立");
        },
        handleWsClose() {
            // 只记录信道断开，**绝不动登录态**（登录态不归 websocket 管）
            // 断线重连由 connectWebSocket 内部负责，不需要用户刷新页面
            console.warn("实时通信websocket断开, 正在尝试自动重连");
        },
        handleWsMessage(state, e) {
            const data = JSON.parse(e.data);
            // console.log(data);
            switch (data.type) {
                case "error": {
                    // 系统错误
                    if (data.data === "登录已过期") {
                        // 后端明确判定 token 失效，这是唯一权威的"登出"信号，此时才清空登录态
                        // (连接断开的 close 事件不算，见 handleWsClose)
                        resetLoginState(state);
                        // 本地缓存必须成对清除，否则刷新后会凭 teri_user 恢复出"已登录"的假象
                        localStorage.removeItem("teri_token");
                        localStorage.removeItem("teri_user");
                    }
                    ElMessage.error(data.data);
                    break;
                }
                case "reply": {
                    // 回复我的
                    let content = data.data;
                    // console.log(content);
                    switch (content.type) {
                        case "全部已读": {
                            state.msgUnread[0] = 0; // 清除回复我的的未读数
                            break;
                        }
                        case "接收": {
                            state.msgUnread[0] ++;
                            break;
                        }
                    }
                    break;
                }
                case "at": {
                    // @ 我的
                    let content = data.data;
                    // console.log(content);
                    switch (content.type) {
                        case "全部已读": {
                            state.msgUnread[1] = 0; // 清除@我的的未读数
                            break;
                        }
                        case "接收": {
                            state.msgUnread[1] ++;
                            break;
                        }
                    }
                    break;
                }
                case "love": {
                    // 收到的赞
                    let content = data.data;
                    // console.log(content);
                    switch (content.type) {
                        case "全部已读": {
                            state.msgUnread[2] = 0; // 清除收到的赞的未读数
                            break;
                        }
                        case "接收": {
                            state.msgUnread[2] ++;
                            break;
                        }
                    }
                    break;
                }
                case "system": {
                    // 系统通知
                    let content = data.data;
                    // console.log(content);
                    switch (content.type) {
                        case "全部已读": {
                            state.msgUnread[3] = 0; // 清除系统通知的未读数
                            break;
                        }
                        case "接收": {
                            state.msgUnread[3] ++;
                            break;
                        }
                    }
                    break;
                }
                case "whisper": {
                    // 我的消息（私聊）
                    let content = data.data;
                    // console.log(content);
                    switch (content.type) {
                        case "全部已读": {
                            state.msgUnread[4] = 0; // 清除我的消息的未读数
                            state.chatList.forEach(item => {
                                item.chat.unread = 0;   // 将聊天列表中的全部未读清除
                            })
                            break;
                        }
                        case "已读": {
                            const chatid = content.id;  // 聊天id（不是url那个参数mid）
                            const count = content.count;
                            state.msgUnread[4] = Math.max(0, state.msgUnread[4] - count);   // 减少相应的未读数
                            let chat = state.chatList.find(item => item.chat.id === chatid);
                            if (chat) {
                                chat.chat.unread = 0;   // 清除对应聊天的未读
                            }
                            break;
                        }
                        case "移除": {
                            const chatid = content.id;  // 聊天id（不是url那个参数mid）
                            const count = content.count;
                            state.msgUnread[4] = Math.max(0, state.msgUnread[4] - count);   // 减少相应的未读数
                            let i = state.chatList.findIndex(item => item.chat.id === chatid);
                            if (i !== -1) {
                                // 如果是当前聊天先关闭窗口
                                if (state.chatList[i].user.uid === state.chatId) state.chatId = -1;
                                state.chatList.splice(i, 1);    // 再移除这个聊天
                            }
                            break;
                        }
                        case "接收": {
                            const chat = content.chat;
                            const detail = content.detail;  // 新消息详情
                            const user = content.user;
                            // 按时间从最近到最远排序
                            const sortByLatestTime = list => {
                                list.sort((a, b) => {
                                    const timeA = new Date(a.chat.latestTime).getTime();
                                    const timeB = new Date(b.chat.latestTime).getTime();
                                    return timeB - timeA;
                                });
                            }
                            if (detail.userId === state.user.uid) {
                                // 如果发送方是自己
                                let chatItem = state.chatList.find(item => item.chat.anotherId === detail.anotherId);
                                if (chatItem && state.isChatPage) {
                                    // 如果该聊天存在并且当前在聊天界面 就尾插新消息以及更新时间并重排序
                                    chatItem.detail.list.push(detail);
                                    chatItem.chat.latestTime = chat.latestTime;
                                    sortByLatestTime(state.chatList);
                                }
                            } else {
                                // 如果发送方是别人 需要判断当前是否有一个页面在该聊天窗口以更新全部未读数
                                if (!content.online) {
                                    state.msgUnread[4]++;
                                }
                                // 不需判断当前页面是否聊天页面了 都要更新消息
                                let chatItem = state.chatList.find(item => item.chat.anotherId === detail.userId);
                                if (chatItem) {
                                    // 如果原来有这个聊天就更新数据
                                    chatItem.detail.list.push(detail);
                                    chatItem.chat = chat;
                                    sortByLatestTime(state.chatList);
                                } else {
                                    // 如果没有就创建聊天
                                    chatItem = {
                                        chat: chat,
                                        user: user,
                                        detail: {
                                            more: true,
                                            list: []
                                        }
                                    };
                                    chatItem.detail.list.push(detail);
                                    state.chatList.unshift(chatItem);
                                }
                            }
                            break;
                        }
                        case "撤回": {
                            const msgId = content.id;
                            const sendId = content.sendId;
                            const acceptId = content.acceptId;
                            let chat;
                            if (sendId === state.user.uid) {
                                // 发送者是自己，找接收者的聊天
                                chat = state.chatList.find(item => item.chat.anotherId === acceptId);
                            } else {
                                // 发送者是对方，找发送者的聊天
                                chat = state.chatList.find(item => item.chat.anotherId === sendId);
                            }
                            if (chat) {
                                // 找到对应消息更改字段
                                let msg = chat.detail.list.find(item => item.id === msgId);
                                if (msg) {
                                    msg.withdraw = 1;
                                }
                            }
                            break;
                        }
                    }
                    break;
                }
                case "dynamic": {
                    // 动态
                    let content = data.content;
                    // console.log(content);
                    switch (content.type) {
                        case "全部已读": {
                            state.msgUnread[5] = 0; // 清除动态的未读数
                            break;
                        }
                        case "接收": {
                            state.msgUnread[5] ++;
                            break;
                        }
                    }
                    break;
                }
            }

        },
        handleWsError(_, e) {
            console.log("实时通信websocket报错: ", e);
        },
    },
    actions: {
        // 获取当前用户信息
        async getPersonalInfo(context) {
            // 这里为了更方便捕捉到错误后做出反应，就不使用封装的函数了
            const result = await axios.get("/api/user/personal/info", {
                headers: {
                    Authorization: "Bearer " + localStorage.getItem("teri_token"),
                },
            })
                .catch((err) => {
                    // 只有后端"明确的未登录"信号（403 + 响应头 message: not login，判定口径与 request.js 一致）才清登录态；
                    // 网络抖动、超时、后端或 dev server 重启导致的连接失败一律保留登录态，避免把用户误"踢"下线
                    if (err.response && err.response.headers && err.response.headers.message === 'not login') {
                        context.dispatch("clearLoginState");
                        ElMessage.error("请登录后查看");
                    } else {
                        ElMessage.error("网络异常，请稍后重试");
                    }
                });
            if (!result) return;
            if (result.data.code === 200) {
                context.commit("updateUser", result.data.data);
                context.state.isLogin = true;
            }
        },

        // 退出登录
        logout(context) {
            // 先把token取出来，清空登录态后就取不到了，而退出请求还要靠它去清后端的redis缓存
            const token = localStorage.getItem("teri_token");
            // 先修改状态再发送请求，防止token过期导致退出失败
            context.dispatch("clearLoginState");
            // 发送退出请求，处理redis中的缓存信息，不能用异步，不然token过期导致退出失败，后面步骤卡死
            axios.get("/api/user/account/logout", {
                headers: {
                    Authorization: "Bearer " + token,
                },
            })
            .catch(() => {});
        },

        // 登录态失效时的统一清理：退出登录、接口返回未登录、后端判定token过期都走这里
        // 要点：vuex状态、本地缓存、长连接、待重连定时器 必须一起复位，少清一样就会出现前后端登录态分裂
        clearLoginState({ commit, state }) {
            commit("initData");
            stopReconnect();
            closeSocketSilently(imSocket || state.ws);
            imSocket = null;
            commit('setWebSocket', null);
            // teri_token 与 teri_user 必须成对清理
            localStorage.removeItem("teri_token");
            localStorage.removeItem("teri_user");
        },

        // 获取全部未读消息数
        async getMsgUnread({ state }) {
            const res = await get("/msg-unread/all", {
                headers: { Authorization: "Bearer " + localStorage.getItem('teri_token') }
            });
            const data = res.data.data;
            state.msgUnread[0] = data.reply;
            state.msgUnread[1] = data.at;
            state.msgUnread[2] = data.love;
            state.msgUnread[3] = data.system;
            state.msgUnread[4] = data.whisper;
            state.msgUnread[5] = data.dynamic;
        },

        // 初始化websocket实例（内部负责鉴权与断线重连，调用方不需要关心重连）
        connectWebSocket({ commit, state, dispatch }) {
            return new Promise((resolve, reject) => {
                // 先关掉旧连接，主动关闭不会触发重连
                closeSocketSilently(imSocket || state.ws);
                stopReconnect();

                const wsBaseUrl = `ws://${window.location.host}`;
                const ws = new WebSocket(`${wsBaseUrl}/im`);
                imSocket = ws;

                const timeout = setTimeout(() => {
                    // 5秒还没连上就放弃这一次，关掉后由 close 事件触发重连，避免卡死在"连接中"
                    try {
                        ws.close();
                    } catch (e) {
                        // 忽略关闭异常
                    }
                    reject(new Error('WebSocket连接超时'));
                }, 5000);

                ws.addEventListener('open', () => {
                    clearTimeout(timeout);
                    // 已被超时逻辑放弃的连接不再使用
                    if (ws.readyState !== WebSocket.OPEN) return;
                    // 握手期间可能已经退出登录了，这时直接关掉，避免后端回一句"登录已过期"造成误报
                    if (!localStorage.getItem("teri_token")) {
                        closeSocketSilently(ws);
                        if (imSocket === ws) imSocket = null;
                        if (state.ws === ws) commit('setWebSocket', null);
                        reject(new Error('未登录, 已取消IM连接'));
                        return;
                    }
                    imReconnectCount = 0;   // 连接成功，重置退避次数
                    commit('setWebSocket', ws); // 只在这里赋值，保证 state.ws 一定是已连接可发送的实例
                    // 连接建立后立刻发送鉴权指令，后端据此绑定uid（重连后同样需要）
                    ws.send(buildAuthCommand());
                    commit('handleWsOpen');
                    resolve();
                });

                ws.addEventListener('close', () => {
                    clearTimeout(timeout);
                    if (imSocket === ws) imSocket = null;
                    if (state.ws === ws) commit('setWebSocket', null);
                    commit('handleWsClose');
                    // 主动关闭（退出登录/页面卸载/替换旧连接）：不重连
                    if (ws.imManualClose) return;
                    // token都清了：说明确实退出了登录，不重连
                    if (!localStorage.getItem("teri_token")) return;
                    dispatch('scheduleReconnect');
                });

                ws.addEventListener('message', e => commit('handleWsMessage', e));

                ws.addEventListener('error', e => {
                    clearTimeout(timeout);
                    commit('handleWsError', e);
                    reject(new Error('WebSocket连接失败'));
                });
            });
        },

        // 断线后的自动重连（指数退避，最长30秒一次）
        // 只有确实还持有 token 时才重连，token 真过期的情况交给后端回"登录已过期"去判定
        scheduleReconnect({ dispatch }) {
            if (imReconnectTimer) return;   // 已经有排队的重连了，避免重复
            if (!localStorage.getItem("teri_token")) return;
            const delay = Math.min(1000 * Math.pow(2, imReconnectCount), IM_RECONNECT_MAX_DELAY);
            imReconnectCount++;
            imReconnectTimer = setTimeout(() => {
                imReconnectTimer = null;
                // 等待期间可能已经退出登录了
                if (!localStorage.getItem("teri_token")) return;
                // 连接失败会再次触发close并重新排队，这里只吞掉promise的报错
                dispatch('connectWebSocket').catch(() => {});
            }, delay);
        },

        // 关闭后清空 WebSocket 实例（页面卸载时调用，不会再触发重连）
        async closeWebSocket({ commit, state }) {
            stopReconnect();
            closeSocketSilently(imSocket || state.ws);
            imSocket = null;
            commit('setWebSocket', null);
        },
    }
})