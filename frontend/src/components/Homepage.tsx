import styles from './Homepage.module.scss';
import React, {useEffect, useState} from "react";
import {NavigateFunction, useNavigate} from "react-router-dom";
import {useDispatch, useSelector} from "react-redux";
import {AppDispatch, RootState} from "../redux/Store";
import {BASE_API_URL, TOKEN} from "../config/Config";
import EditGroupChat from "./editChat/EditGroupChat";
import Profile from "./profile/Profile";
import {Alert, Avatar, Divider, IconButton, InputAdornment, Menu, MenuItem, TextField} from "@mui/material";
import ChatIcon from '@mui/icons-material/Chat';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import {currentUser, logoutUser} from "../redux/auth/AuthAction";
import SearchIcon from '@mui/icons-material/Search';
import {getUserChats, markChatAsRead} from "../redux/chat/ChatAction";
import {ChatDTO} from "../redux/chat/ChatModel";
import ChatCard from "./chatCard/ChatCard";
import {getInitialsFromName} from "./utils/Utils";
import ClearIcon from '@mui/icons-material/Clear';
import WelcomePage from "./welcomePage/WelcomePage";
import MessagePage from "./messagePage/MessagePage";
import {MessageDTO, WebSocketMessageDTO} from "../redux/message/MessageModel";
import {createMessage, getAllMessages} from "../redux/message/MessageAction";
import SockJS from 'sockjs-client';
import {Client, over, Subscription} from "stompjs";
import {AUTHORIZATION_PREFIX} from "../redux/Constants";
import CreateGroupChat from "./editChat/CreateGroupChat";
import CreateSingleChat from "./editChat/CreateSingleChat";
import CryptoService from "../services/CryptoService";
import KeyManagementService from "../services/KeyManagementService";

const Homepage = () => {

    const authState = useSelector((state: RootState) => state.auth);
    const chatState = useSelector((state: RootState) => state.chat);
    const messageState = useSelector((state: RootState) => state.message);
    const navigate: NavigateFunction = useNavigate();
    const dispatch: AppDispatch = useDispatch();
    const token: string | null = localStorage.getItem(TOKEN);
    const [isShowEditGroupChat, setIsShowEditGroupChat] = useState<boolean>(false);
    const [isShowCreateGroupChat, setIsShowCreateGroupChat] = useState<boolean>(false);
    const [isShowCreateSingleChat, setIsShowCreateSingleChat] = useState<boolean>(false);
    const [isShowProfile, setIsShowProfile] = useState<boolean>(false);
    const [anchor, setAnchor] = useState(null);
    const [initials, setInitials] = useState<string>("");
    const [query, setQuery] = useState<string>("");
    const [focused, setFocused] = useState<boolean>(false);
    const [currentChat, setCurrentChat] = useState<ChatDTO | null>(null);
    const [messages, setMessages] = useState<MessageDTO[]>([]);
    const [newMessage, setNewMessage] = useState<string>("");
    const [stompClient, setStompClient] = useState<Client | undefined>();
    const [isConnected, setIsConnected] = useState<boolean>(false);
    const [messageReceived, setMessageReceived] = useState<boolean>(false);
    const [subscribeTry, setSubscribeTry] = useState<number>(1);
    const [missingKeysBanner, setMissingKeysBanner] = useState<boolean>(false);
    const open = Boolean(anchor);

    useEffect(() => {
        if (token && !authState.reqUser) {
            dispatch(currentUser(token));
        }
    }, [token, dispatch, authState.reqUser, navigate]);

    useEffect(() => {
        if (!token || authState.reqUser === null) {
            navigate("/signin");
        }
    }, [token, navigate, authState.reqUser]);

    useEffect(() => {
        if (authState.reqUser && authState.reqUser.fullName) {
            const letters = getInitialsFromName(authState.reqUser.fullName);
            setInitials(letters);
        }
    }, [authState.reqUser?.fullName]);

    useEffect(() => {
        if (token) {
            dispatch(getUserChats(token));
        }
    }, [chatState.createdChat, chatState.createdGroup, dispatch, token, messageState.newMessage, chatState.deletedChat, chatState.editedGroup, chatState.markedAsReadChat]);

    useEffect(() => {
        setCurrentChat(chatState.editedGroup);
    }, [chatState.editedGroup]);

    useEffect(() => {
        if (currentChat?.id && token) {
            dispatch(getAllMessages(currentChat.id, token));
        }
    }, [currentChat, dispatch, token, messageState.newMessage]);

    useEffect(() => {
        setMessages(messageState.messages);
    }, [messageState.messages]);

    useEffect(() => {
        if (messageState.newMessage && stompClient && currentChat && isConnected) {
            const webSocketMessage: WebSocketMessageDTO = {...messageState.newMessage, chat: currentChat};
            stompClient.send("/app/messages", {}, JSON.stringify(webSocketMessage));
        }
    }, [messageState.newMessage]);

    useEffect(() => {
        console.log("Attempting to subscribe to ws: ", subscribeTry);
        if (isConnected && stompClient && stompClient.connected && authState.reqUser) {
            const subscription: Subscription = stompClient.subscribe("/topic/" + authState.reqUser.id.toString(), onMessageReceive);

            return () => subscription.unsubscribe();
        } else {
            const timeout = setTimeout(() => setSubscribeTry(subscribeTry + 1), 500);
            return () => clearTimeout(timeout);
        }
    }, [subscribeTry, isConnected, stompClient, authState.reqUser]);

    useEffect(() => {
        if (messageReceived && currentChat?.id && token) {
            dispatch(markChatAsRead(currentChat.id, token));
            dispatch(getAllMessages(currentChat.id, token));
        }
        if (token) {
            dispatch(getUserChats(token));
        }
        setMessageReceived(false);
    }, [messageReceived]);

    useEffect(() => {
        connect();
    }, []);

    const connect = () => {
        const headers = {
            Authorization: `${AUTHORIZATION_PREFIX}${token}`
        };

        const socket: WebSocket = new SockJS("http://localhost:8080/ws");
        const client: Client = over(socket);
        client.connect(headers, onConnect, onError);
        setStompClient(client);
    };

    const onConnect = async () => {
        setTimeout(() => setIsConnected(true), 1000);
    };

    const onError = (error: any) => {
        console.error("WebSocket connection error", error);
    };

    const onMessageReceive = () => {
        setMessageReceived(true);
    };

    const onSendMessage = async () => {
        if (!currentChat?.id || !token || !authState.reqUser || !newMessage.trim()) return;

        try {
            // Collect all chat member user IDs (including sender)
            const memberIds: string[] = currentChat.users.map(u => u.id.toString());
            const myUserId = authState.reqUser.id.toString();

            // Fetch public keys via batch endpoint
            const idsParam = memberIds.join(',');
            const keysRes = await fetch(`${BASE_API_URL}/api/users/public-keys?userIds=${idsParam}`, {
                headers: {
                    Authorization: `${AUTHORIZATION_PREFIX}${token}`,
                },
            });
            const publicKeysMap: Record<string, string> = await keysRes.json();

            // Check all members have a public key
            const recipients: { userId: string; publicKey: string }[] = [];
            for (const memberId of memberIds) {
                if (publicKeysMap[memberId]) {
                    recipients.push({ userId: memberId, publicKey: publicKeysMap[memberId] });
                }
            }

            if (recipients.length !== memberIds.length) {
                setMissingKeysBanner(true);
                setTimeout(() => setMissingKeysBanner(false), 5000);
                return;
            }

            // Hybrid encrypt
            const encrypted = await CryptoService.hybridEncrypt(newMessage.trim(), recipients);

            // Send encrypted payload
            dispatch(createMessage({
                chatId: currentChat.id,
                content: encrypted.ciphertext,
                iv: encrypted.iv,
                encryptedAesKeys: encrypted.encryptedAesKeys,
            }, token));
            setNewMessage("");
        } catch (error) {
            console.error('Failed to encrypt and send message:', error);
        }
    };

    const onOpenProfile = () => {
        onCloseMenu();
        setIsShowProfile(true);
    };

    const onCloseProfile = () => {
        setIsShowProfile(false);
    };

    const onOpenMenu = (e: any) => {
        setAnchor(e.currentTarget);
    };

    const onCloseMenu = () => {
        setAnchor(null);
    };

    const onCreateGroupChat = () => {
        onCloseMenu();
        setIsShowCreateGroupChat(true);
    };

    const onCreateSingleChat = () => {
        setIsShowCreateSingleChat(true);
    };

    const onLogout = () => {
        dispatch(logoutUser());
        navigate("/signin");
    };

    const onChangeQuery = (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
        setQuery(e.target.value.toLowerCase());
    };

    const onClearQuery = () => {
        setQuery("");
    };

    const onClickChat = (chat: ChatDTO) => {
        if (token) {
            dispatch(markChatAsRead(chat.id, token));
        }
        setCurrentChat(chat);
    };

    const getSearchEndAdornment = () => {
        return query.length > 0 &&
            <InputAdornment position='end'>
                <IconButton onClick={onClearQuery}>
                    <ClearIcon/>
                </IconButton>
            </InputAdornment>
    };

    return (
        <div>
            <div className={styles.outerContainer}>
                <div className={styles.innerContainer}>
                    <div className={styles.sideBarContainer}>
                        {isShowCreateSingleChat &&
                            <CreateSingleChat setIsShowCreateSingleChat={setIsShowCreateSingleChat}/>}
                        {isShowCreateGroupChat &&
                            <CreateGroupChat setIsShowCreateGroupChat={setIsShowCreateGroupChat}/>}
                        {isShowEditGroupChat &&
                            <EditGroupChat setIsShowEditGroupChat={setIsShowEditGroupChat} currentChat={currentChat}/>}
                        {isShowProfile &&
                            <div className={styles.profileContainer}>
                                <Profile onCloseProfile={onCloseProfile} initials={initials}/>
                            </div>}
                        {!isShowCreateSingleChat && !isShowEditGroupChat && !isShowCreateGroupChat && !isShowProfile &&
                            <div className={styles.sideBarInnerContainer}>
                                <div className={styles.navContainer}>
                                    <div onClick={onOpenProfile} className={styles.userInfoContainer}>
                                        <Avatar sx={{
                                            width: '2.5rem',
                                            height: '2.5rem',
                                            fontSize: '1rem',
                                            mr: '0.75rem'
                                        }}>
                                            {initials}
                                        </Avatar>
                                        <p>{authState.reqUser?.fullName}</p>
                                    </div>
                                    <div>
                                        <IconButton onClick={onCreateSingleChat}>
                                            <ChatIcon/>
                                        </IconButton>
                                        <IconButton onClick={onOpenMenu}>
                                            <MoreVertIcon/>
                                        </IconButton>
                                        <Menu
                                            id="basic-menu"
                                            anchorEl={anchor}
                                            open={open}
                                            onClose={onCloseMenu}
                                            MenuListProps={{'aria-labelledby': 'basic-button'}}>
                                            <MenuItem onClick={onOpenProfile}>Profile</MenuItem>
                                            <MenuItem onClick={onCreateGroupChat}>Create Group</MenuItem>
                                            <MenuItem onClick={onLogout}>Logout</MenuItem>
                                        </Menu>
                                    </div>
                                </div>
                                <div className={styles.searchContainer}>
                                    <TextField
                                        id='search'
                                        type='text'
                                        label='Search your chats ...'
                                        size='small'
                                        fullWidth
                                        value={query}
                                        onChange={onChangeQuery}
                                        InputProps={{
                                            startAdornment: (
                                                <InputAdornment position='start'>
                                                    <SearchIcon/>
                                                </InputAdornment>
                                            ),
                                            endAdornment: getSearchEndAdornment(),
                                        }}
                                        InputLabelProps={{
                                            shrink: focused || query.length > 0,
                                            style: {marginLeft: focused || query.length > 0 ? 0 : 30}
                                        }}
                                        onFocus={() => setFocused(true)}
                                        onBlur={() => setFocused(false)}/>
                                </div>
                                <div className={styles.chatsContainer}>
                                    {query.length > 0 && chatState.chats?.filter(x =>
                                        x.isGroup ? x.chatName.toLowerCase().includes(query) :
                                            x.users[0].id === authState.reqUser?.id ? x.users[1].fullName.toLowerCase().includes(query) :
                                                x.users[0].fullName.toLowerCase().includes(query))
                                        .map((chat: ChatDTO) => (
                                            <div key={chat.id} onClick={() => onClickChat(chat)}>
                                                <Divider/>
                                                <ChatCard chat={chat}/>
                                            </div>
                                        ))}
                                    {query.length === 0 && chatState.chats?.map((chat: ChatDTO) => (
                                        <div key={chat.id} onClick={() => onClickChat(chat)}>
                                            <Divider/>
                                            <ChatCard chat={chat}/>
                                        </div>
                                    ))}
                                    {chatState.chats?.length > 0 ? <Divider/> : null}
                                </div>
                            </div>}
                    </div>
                    <div className={styles.messagesContainer}>
                        {missingKeysBanner && (
                            <Alert severity="warning" sx={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1000 }}>
                                One or more chat members are missing a public key. Message cannot be encrypted and sent until all members have uploaded a public key.
                            </Alert>
                        )}
                        {!currentChat && <WelcomePage reqUser={authState.reqUser}/>}
                        {currentChat && <MessagePage
                            chat={currentChat}
                            reqUser={authState.reqUser}
                            messages={messages}
                            newMessage={newMessage}
                            setNewMessage={setNewMessage}
                            onSendMessage={onSendMessage}
                            setIsShowEditGroupChat={setIsShowEditGroupChat}
                            setCurrentChat={setCurrentChat}/>}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default Homepage;
