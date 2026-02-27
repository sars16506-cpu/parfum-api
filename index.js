// store/index.js
import authReducer from "./authSlice";
import { authApi } from "./authApi";

export const store = configureStore({
  reducer: {
    auth: authReducer,           // ← добавь
    [authApi.reducerPath]: authApi.reducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware().concat(authApi.middleware),
});