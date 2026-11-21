import '@expo/metro-runtime';
import '../../../component-review/review.css';
import { registerRootComponent } from 'expo';
import { Harness } from './Harness';

// Never import App.tsx: push, observe, and widget startup belong to the native
// app. This check renders the real attachment components against review fixtures.
registerRootComponent(Harness);
