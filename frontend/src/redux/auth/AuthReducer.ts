import {AuthReducerState} from "./AuthModel";
import * as actionTypes from './AuthActionType';
import {Action} from "../CommonModel";

const initialState: AuthReducerState = {
    signin: null,
    signup: null,
    reqUser: null,
    searchUser: null,
    updateUser: null,
    uploadedPublicKey: null,
    fetchedPublicKey: null,
    passwordChanged: null,
};

const authReducer = (state: AuthReducerState = initialState, action: Action): AuthReducerState => {
    switch (action.type) {
        case actionTypes.REGISTER:
            return {...state, signup: action.payload};
        case actionTypes.LOGIN_USER:
            return {...state, signin: action.payload};
        case actionTypes.REQ_USER:
            return {...state, reqUser: action.payload};
        case actionTypes.SEARCH_USER:
            return {...state, searchUser: action.payload};
        case actionTypes.UPDATE_USER:
            return {...state, updateUser: action.payload};
        case actionTypes.UPLOAD_PUBLIC_KEY:
            return {...state, uploadedPublicKey: action.payload};
        case actionTypes.FETCH_PUBLIC_KEY:
            return {...state, fetchedPublicKey: action.payload};
        case actionTypes.FETCH_ALL_PUBLIC_KEYS:
            return {...state};
        case actionTypes.CHANGE_PASSWORD:
            return {...state, passwordChanged: action.payload};
        case actionTypes.LOGOUT_USER:
            return {...state, signin: null, signup: null, reqUser: null, uploadedPublicKey: null, fetchedPublicKey: null, passwordChanged: null};
    }
    return state;
};

export default authReducer;
